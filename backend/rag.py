import gc
import io
import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Iterable

from dotenv import load_dotenv
from langchain_community.document_loaders import Docx2txtLoader, PyPDFLoader, TextLoader
from langchain_community.vectorstores import FAISS
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_groq import ChatGroq
from langchain_openai import ChatOpenAI
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.embeddings import FastEmbedEmbeddings

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
SUPPORTED_EXTENSIONS = {".pdf", ".docx", ".txt", ".pptx"}
INDEX_BATCH_SIZE = int(os.getenv("INDEX_BATCH_SIZE", "64"))
RETRIEVAL_K = int(os.getenv("RETRIEVAL_K", "8"))
MAX_CONTEXT_CHARS = int(os.getenv("MAX_CONTEXT_CHARS", "12000"))

STOPWORDS = {
    "what", "is", "the", "a", "an", "of", "for", "to", "in", "on", "about",
    "tell", "me", "please", "explain", "define", "give", "with", "and",
}

# ---------------------------------------------------------------------------
# Thread-safe in-memory FAISS cache
# Each worker keeps its own copy; this prevents concurrent dict corruption.
# ---------------------------------------------------------------------------
_cache: dict[str, FAISS] = {}
_cache_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Singleton embeddings  (loaded once per process)
# ---------------------------------------------------------------------------
_embeddings = None
_embeddings_lock = threading.Lock()


def get_embeddings():
    global _embeddings
    if _embeddings is None:
        with _embeddings_lock:
            if _embeddings is None:           # double-checked locking
                print("[RAG] Loading embedding model...")
              
                _embeddings = FastEmbedEmbeddings()
    return _embeddings


# ---------------------------------------------------------------------------
# Singleton LLM
# ---------------------------------------------------------------------------
_llm = None
_llm_lock = threading.Lock()


def _get_llm():
    global _llm
    if _llm is None:
        with _llm_lock:
            if _llm is None:
                groq_key = os.getenv("GROQ_API_KEY")
                openai_key = os.getenv("OPENAI_API_KEY")
                if groq_key:
                    print("[RAG] Loading Groq LLM...")
                    _llm = ChatGroq(
                        api_key=groq_key,
                        model=os.getenv("GROQ_MODEL", "llama-3.1-8b-instant"),
                        temperature=0.2,
                    )
                elif openai_key:
                    print("[RAG] Loading OpenAI LLM...")
                    _llm = ChatOpenAI(
                        api_key=openai_key,
                        model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
                        temperature=0.2,
                    )
                else:
                    raise RuntimeError("Set GROQ_API_KEY or OPENAI_API_KEY before chatting.")
    return _llm


# ---------------------------------------------------------------------------
# DB helpers – store FAISS bytes in PostgreSQL so Render's ephemeral disk
# is never relied on. Every worker reads from the same DB → no stale state.
# ---------------------------------------------------------------------------

def _get_db_session():
    """Return a fresh SQLAlchemy session (caller must close it)."""
    try:
        from .database import SessionLocal
    except ImportError:
        from database import SessionLocal
    return SessionLocal()


def _load_index_from_db(user_id: int, chat_id: int) -> bytes | None:
    """Return raw FAISS bytes stored in the ChatFaissIndex table, or None."""
    try:
        try:
            from .models import ChatFaissIndex
        except ImportError:
            from models import ChatFaissIndex

        db = _get_db_session()
        try:
            row = db.query(ChatFaissIndex).filter_by(
                user_id=user_id, chat_id=chat_id
            ).first()
            return row.index_data if row else None
        finally:
            db.close()
    except Exception as exc:
        print(f"[RAG] _load_index_from_db error: {exc}")
        return None


def _save_index_to_db(user_id: int, chat_id: int, index_bytes: bytes):
    """Upsert FAISS bytes into ChatFaissIndex."""
    try:
        from .models import ChatFaissIndex
    except ImportError:
        from models import ChatFaissIndex

    db = _get_db_session()
    try:
        row = db.query(ChatFaissIndex).filter_by(
            user_id=user_id, chat_id=chat_id
        ).first()
        if row:
            row.index_data = index_bytes
        else:
            db.add(ChatFaissIndex(
                user_id=user_id,
                chat_id=chat_id,
                index_data=index_bytes,
            ))
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def _delete_index_from_db(user_id: int, chat_id: int):
    try:
        try:
            from .models import ChatFaissIndex
        except ImportError:
            from models import ChatFaissIndex

        db = _get_db_session()
        try:
            db.query(ChatFaissIndex).filter_by(
                user_id=user_id, chat_id=chat_id
            ).delete()
            db.commit()
        finally:
            db.close()
    except Exception as exc:
        print(f"[RAG] _delete_index_from_db error: {exc}")


# ---------------------------------------------------------------------------
# FAISS serialise / deserialise via a temp directory
# ---------------------------------------------------------------------------

def _vectorstore_to_bytes(vs: FAISS) -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        vs.save_local(tmp)
        buf = io.BytesIO()
        import zipfile
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for f in Path(tmp).iterdir():
                zf.write(f, f.name)
        return buf.getvalue()


def _bytes_to_vectorstore(data: bytes) -> FAISS:
    import zipfile
    with tempfile.TemporaryDirectory() as tmp:
        buf = io.BytesIO(data)
        with zipfile.ZipFile(buf, "r") as zf:
            zf.extractall(tmp)
        return FAISS.load_local(
            tmp,
            get_embeddings(),
            allow_dangerous_deserialization=True,
        )


# ---------------------------------------------------------------------------
# Cache helpers (thread-safe)
# ---------------------------------------------------------------------------

def _cache_key(user_id: int, chat_id: int) -> str:
    return f"{user_id}_{chat_id}"


def _get_cached(user_id: int, chat_id: int) -> FAISS | None:
    with _cache_lock:
        return _cache.get(_cache_key(user_id, chat_id))


def _set_cached(user_id: int, chat_id: int, vs: FAISS):
    with _cache_lock:
        _cache[_cache_key(user_id, chat_id)] = vs


def _evict_cached(user_id: int, chat_id: int):
    with _cache_lock:
        _cache.pop(_cache_key(user_id, chat_id), None)


# ---------------------------------------------------------------------------
# Document loading
# ---------------------------------------------------------------------------

def _load_documents(file_path: str):
    suffix = Path(file_path).suffix.lower()
    if suffix == ".pdf":
        return PyPDFLoader(file_path).load()
    elif suffix == ".docx":
        return Docx2txtLoader(file_path).load()
    elif suffix == ".txt":
        return TextLoader(file_path, encoding="utf-8").load()
    raise ValueError(f"Unsupported file type: {suffix}")


def _load_documents_from_bytes(filename: str, file_bytes: bytes):
    suffix = Path(filename).suffix.lower()
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(file_bytes)
        tmp_path = tmp.name
    try:
        return _load_documents(tmp_path)
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def process_file(
    user_id: int,
    chat_id: int,
    filename: str,
    file_bytes: bytes,
    source_name: str,
) -> int:
    """Chunk, embed, and persist a document for the given chat."""
    docs = _load_documents_from_bytes(filename, file_bytes)
    gc.collect()


    splitter = RecursiveCharacterTextSplitter(
      chunk_size=1000,
      chunk_overlap=200
     )

    chunks = splitter.split_documents(docs)
    if not chunks:
        raise ValueError("No readable text was found in this document.")

    for chunk in chunks:
        chunk.metadata.update(
            {"user_id": user_id, "chat_id": chat_id, "source": source_name}
        )

    # Build / extend the vectorstore in batches so larger PDFs do not require
    # embedding every chunk in one memory-heavy call.
    existing_bytes = _load_index_from_db(user_id, chat_id)
    if existing_bytes:
        vs = _bytes_to_vectorstore(existing_bytes)
        start = 0
    else:
        first_batch = chunks[:INDEX_BATCH_SIZE]
        vs = FAISS.from_documents(first_batch, get_embeddings())
        start = INDEX_BATCH_SIZE

    for index in range(start, len(chunks), INDEX_BATCH_SIZE):
        vs.add_documents(chunks[index:index + INDEX_BATCH_SIZE])
        gc.collect()

    # Persist to PostgreSQL and refresh cache
    _save_index_to_db(user_id, chat_id, _vectorstore_to_bytes(vs))
    _set_cached(user_id, chat_id, vs)

    return len(chunks)


def _get_vectorstore(user_id: int, chat_id: int) -> FAISS | None:
    """Return FAISS vectorstore, hitting the in-memory cache first."""
    vs = _get_cached(user_id, chat_id)
    if vs is not None:
        return vs

    data = _load_index_from_db(user_id, chat_id)
    if data is None:
        return None

    vs = _bytes_to_vectorstore(data)
    _set_cached(user_id, chat_id, vs)
    return vs


def delete_chat_index(user_id: int, chat_id: int):
    _evict_cached(user_id, chat_id)
    _delete_index_from_db(user_id, chat_id)


# ---------------------------------------------------------------------------
# Relevance check
# ---------------------------------------------------------------------------

def _extract_query_terms(query: str) -> list[str]:
    terms = re.findall(r"[A-Za-z0-9_+-]+", query.lower())
    return [
        t for t in terms
        if t not in STOPWORDS and (len(t) > 2 or t.isupper())
    ]


def _is_relevant_match(query: str, docs: list, scores: list[float]) -> bool:
    if not docs:
        return False
    combined = " ".join(d.page_content.lower() for d in docs)
    terms = _extract_query_terms(query)
    if not terms:
        return False
    matched = [t for t in terms if t in combined]
    ratio = len(matched) / len(terms)
    best = min(scores) if scores else None
    if best is not None and best > 1.25 and ratio < 0.5:
        return False
    return ratio >= 0.34


def _format_history(history: Iterable[dict]) -> list:
    result = []
    for item in history:
        if item["role"] == "user":
            result.append(HumanMessage(content=item["content"]))
        else:
            result.append(AIMessage(content=item["content"]))
    return result


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a RAG assistant.

1. First, try to answer using the provided context (document).
2. If the answer is clearly found in the context, respond using it.
4. Always follow this format:
   - If answer is from document → start with "From document:"
   - If answer is not in document → start with "From general knowledge:"
5. Do not say "I cannot find the answer" unless both context and general knowledge fail.

Question: {question}
Context: {context}
"""


def get_answer(user_id: int, chat_id: int, query: str, history: Iterable[dict]) -> dict:
    vectorstore = _get_vectorstore(user_id, chat_id)

    if vectorstore is None:
        return {
            "answer": "No documents have been uploaded for this chat yet.",
            "sources": [],
        }

    scored_docs = vectorstore.similarity_search_with_score(query, k=RETRIEVAL_K)
    docs = [d for d, _ in scored_docs]

    if not docs:
        return {
            "answer": "I could not find a relevant answer for that question in the uploaded document(s) for this chat.",
            "sources": [],
        }

    context_parts = []
    total_chars = 0
    for doc in docs:
        content = doc.page_content.strip()
        if not content:
            continue
        remaining = MAX_CONTEXT_CHARS - total_chars
        if remaining <= 0:
            break
        context_parts.append(content[:remaining])
        total_chars += len(context_parts[-1])

    context = "\n\n".join(context_parts)
    if not context:
        return {
            "answer": "The uploaded document was indexed, but I could not read usable text from the matching pages.",
            "sources": [],
        }

    messages = [
        SystemMessage(content=f"{SYSTEM_PROMPT}\n\nRetrieved context:\n{context}"),
        *_format_history(history),
        HumanMessage(content=query),
    ]

    response = _get_llm().invoke(messages)

    sources = []
    for doc in docs:
        src = doc.metadata.get("source", "Uploaded file")
        if src not in sources:
            sources.append(src)

    return {"answer": response.content, "sources": sources}
