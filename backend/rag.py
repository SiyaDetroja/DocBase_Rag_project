import os
import shutil
import tempfile
import re
from pathlib import Path
from typing import Iterable

from langchain_community.document_loaders import Docx2txtLoader, PyPDFLoader, TextLoader
from langchain_community.vectorstores import FAISS
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from dotenv import load_dotenv
from langchain_groq import ChatGroq
from langchain_openai import ChatOpenAI
from langchain_text_splitters import RecursiveCharacterTextSplitter


load_dotenv(Path(__file__).resolve().parent.parent / ".env")
# 🔥 ADD THIS GLOBAL CACHE
VECTORSTORE_CACHE = {}


BASE_DIR = Path(__file__).resolve().parent.parent
FAISS_ROOT = BASE_DIR / "faiss_indexes"
SUPPORTED_EXTENSIONS = {".pdf", ".docx", ".txt"}

_embeddings = None

def get_embeddings():
    global _embeddings
    if _embeddings is None:
        print(" Loading model...")
        from langchain_community.embeddings import FastEmbedEmbeddings
        _embeddings = FastEmbedEmbeddings()
    return _embeddings
STOPWORDS = {
    "what", "is", "the", "a", "an", "of", "for", "to", "in", "on", "about",
    "tell", "me", "please", "explain", "define", "give", "with", "and",
}


def get_chat_index_path(user_id: int, chat_id: int) -> Path:
    return FAISS_ROOT / f"faiss_index_user_{user_id}_chat_{chat_id}"


def _load_documents(file_path: str):
    suffix = Path(file_path).suffix.lower()

    if suffix == ".pdf":
        loader = PyPDFLoader(file_path)
    elif suffix == ".docx":
        loader = Docx2txtLoader(file_path)
    elif suffix == ".txt":
        loader = TextLoader(file_path, encoding="utf-8")
    else:
        raise ValueError(f"Unsupported file type: {suffix}")

    return loader.load()


def _load_documents_from_bytes(filename: str, file_bytes: bytes):
    suffix = Path(filename).suffix.lower()
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
        temp_file.write(file_bytes)
        temp_path = temp_file.name

    try:
        return _load_documents(temp_path)
    finally:
        try:
            os.remove(temp_path)
        except OSError:
            pass


def process_file(user_id: int, chat_id: int, filename: str, file_bytes: bytes, source_name: str) -> int:
    docs = _load_documents_from_bytes(filename, file_bytes)
    
    import gc
    gc.collect()

    # Split large files into overlapping chunks so retrieval has focused context.
    splitter = RecursiveCharacterTextSplitter(chunk_size=400, chunk_overlap=50)
    chunks = splitter.split_documents(docs)
    chunks = chunks[:300] 

    for chunk in chunks:
        chunk.metadata["user_id"] = user_id
        chunk.metadata["chat_id"] = chat_id
        chunk.metadata["source"] = source_name

    index_path = get_chat_index_path(user_id, chat_id)
    index_path.parent.mkdir(parents=True, exist_ok=True)

    if index_path.exists():
        # Each user has an isolated FAISS folder, so their embeddings never mix.
        vectorstore = FAISS.load_local(
            str(index_path),
            get_embeddings(),
            allow_dangerous_deserialization=True,
        )
        vectorstore.add_documents(chunks)
    else:
        vectorstore = FAISS.from_documents(chunks, get_embeddings())

    vectorstore.save_local(str(index_path))
    return len(chunks)


def _get_vectorstore(user_id: int, chat_id: int):
    key = f"{user_id}_{chat_id}"

    # ✅ return from cache if already loaded
    if key in VECTORSTORE_CACHE:
        return VECTORSTORE_CACHE[key]

    index_path = get_chat_index_path(user_id, chat_id)
    if not index_path.exists():
        return None

    vs = FAISS.load_local(
        str(index_path),
        get_embeddings(),
        allow_dangerous_deserialization=True,
    )

    # ✅ store in cache
    VECTORSTORE_CACHE[key] = vs
    return vs

def _build_llm():
    groq_api_key = os.getenv("GROQ_API_KEY")
    openai_api_key = os.getenv("OPENAI_API_KEY")

    if groq_api_key:
        return ChatGroq(
            api_key=groq_api_key,
            model=os.getenv("GROQ_MODEL", "llama-3.1-8b-instant"),
            temperature=0.2,
        )

    if openai_api_key:
        return ChatOpenAI(
            api_key=openai_api_key,
            model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            temperature=0.2,
        )

    raise RuntimeError("Set GROQ_API_KEY or OPENAI_API_KEY before chatting.")


def _extract_query_terms(query: str) -> list[str]:
    terms = re.findall(r"[A-Za-z0-9_+-]+", query.lower())
    filtered_terms = []
    for term in terms:
        if term in STOPWORDS:
            continue
        if len(term) <= 2 and not term.isupper():
            continue
        filtered_terms.append(term)
    return filtered_terms


def _is_relevant_match(query: str, retrieved_docs: list, scores: list[float]) -> bool:
    if not retrieved_docs:
        return False

    combined_text = " ".join(doc.page_content.lower() for doc in retrieved_docs)
    query_terms = _extract_query_terms(query)

    if not query_terms:
        return False

    matched_terms = [term for term in query_terms if term.lower() in combined_text]
    match_ratio = len(matched_terms) / len(query_terms)

    best_score = min(scores) if scores else None

    # FAISS distance is lower when the match is better.
    if best_score is not None and best_score > 1.25 and match_ratio < 0.5:
        return False

    if match_ratio < 0.34:
        return False

    return True


def _format_history(history: Iterable[dict]) -> list:
    messages = []
    for item in history:
        if item["role"] == "user":
            messages.append(HumanMessage(content=item["content"]))
        else:
            messages.append(AIMessage(content=item["content"]))
    return messages


def delete_chat_index(user_id: int, chat_id: int):
    index_path = get_chat_index_path(user_id, chat_id)
    if index_path.exists():
        shutil.rmtree(index_path, ignore_errors=True)


def get_answer(user_id: int, chat_id: int, query: str, history: Iterable[dict]):
    vectorstore = _get_vectorstore(user_id, chat_id)
    retrieved_docs = []
    context = ""

    if vectorstore is not None:
        # Retrieval converts the question into an embedding and es relevant chunks.
        scored_docs = vectorstore.similarity_search_with_score(query, k=5)
        retrieved_docs = [doc for doc, _score in scored_docs]
        scores = [score for _doc, score in scored_docs]
        if retrieved_docs and _is_relevant_match(query, retrieved_docs, scores):
            context = "\n\n".join(doc.page_content for doc in retrieved_docs)

    if vectorstore is None:
        return {
            "answer": "No documents have been uploaded for this chat yet.",
            "sources": [],
        }

    if not context:
        return {
            "answer": "I could not find a relevant answer for that question in the uploaded document(s) for this chat.",
            "sources": [],
        }

    system_prompt = """
    You are a RAG assistant.

    1. First, try to answer using the provided context (document).
    2. If the answer is clearly found in the context, respond using it.

    4. Always follow this format:
    - If answer is from document → start with "From document:"
    - If answer is not in document → start with "From general knowledge:"

    5. Do not say "I cannot find the answer" unless both context and general knowledge fail.

    Question: {question}
    Context: {context}
    """

    llm_messages = [
        SystemMessage(content=f"{system_prompt}\n\nRetrieved context:\n{context}"),
        *_format_history(history),
        HumanMessage(content=query),
    ]

    _llm = None

    def get_llm():
        global _llm
        if _llm is None:
            print("🚀 Loading LLM...")
            _llm = _build_llm()
        return _llm

    response = get_llm().invoke(llm_messages)

    sources = []
    for doc in retrieved_docs:
        source_name = doc.metadata.get("source", "Uploaded file")
        if source_name not in sources:
            sources.append(source_name)

    return {
        "answer": response.content,
        "sources": sources,
    }
