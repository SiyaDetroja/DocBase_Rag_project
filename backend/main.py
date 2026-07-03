import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session, joinedload

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

try:
    from .auth import create_access_token, get_current_user_id, hash_password, verify_password
    from .database import Base, SessionLocal, engine
    from .models import Chat, Message, UploadedDocument, User
    from .rag import SUPPORTED_EXTENSIONS, delete_chat_index, get_answer, process_file
except ImportError:
    from auth import create_access_token, get_current_user_id, hash_password, verify_password
    from database import Base, SessionLocal, engine
    from models import Chat, Message, UploadedDocument, User
    from rag import SUPPORTED_EXTENSIONS, delete_chat_index, get_answer, process_file


Base.metadata.create_all(bind=engine)

app = FastAPI(title="RAG Web App")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://docbaseragapp.vercel.app",      
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def get_db():
    # Every request gets its own SQLAlchemy session and closes it afterward.
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _validate_password_strength(password: str):
    has_upper = any(char.isupper() for char in password)
    has_lower = any(char.islower() for char in password)
    has_digit = any(char.isdigit() for char in password)
    has_special = any(not char.isalnum() for char in password)

    if not (has_upper and has_lower and has_digit and has_special):
        raise HTTPException(
            status_code=400,
            detail="Password must include uppercase, lowercase, number, and special character",
        )


class SignupInput(BaseModel):
    username: str = Field(min_length=3, max_length=50)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class LoginInput(BaseModel):
    identifier: str
    password: str = Field(min_length=8, max_length=128)


class ResetPasswordInput(BaseModel):
    identifier: str
    new_password: str = Field(min_length=8, max_length=128)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    chat_id: Optional[int] = None


class CreateChatRequest(BaseModel):
    title: str = "New Chat"


def _create_chat_title(text: str) -> str:
    cleaned = " ".join(text.strip().split())
    return cleaned[:40] or "New Chat"


def _serialize_message(message: Message):
    return {
        "id": message.id,
        "role": message.role,
        "content": message.content,
        "timestamp": message.timestamp.isoformat() if message.timestamp else None,
    }


def _serialize_document(document: UploadedDocument):
    return {
        "id": document.id,
        "name": document.original_name,
        "created_at": document.created_at.isoformat() if document.created_at else None,
    }


def _serialize_chat(chat: Chat):
    has_user_messages = any(message.role == "user" for message in chat.messages)
    chat_title = chat.title if has_user_messages else "New Chat"
    return {
        "id": chat.id,
        "title": chat_title,
        "created_at": chat.created_at.isoformat() if chat.created_at else None,
        "updated_at": chat.updated_at.isoformat() if chat.updated_at else None,
        "documents": [_serialize_document(document) for document in chat.documents],
        "messages": [_serialize_message(message) for message in chat.messages],
    }

@app.get("/")
def root():
    return {"message": "API is running 🚀"}

@app.post("/signup", status_code=status.HTTP_201_CREATED)
def signup(payload: SignupInput, db: Session = Depends(get_db)):
    _validate_password_strength(payload.password)
    existing_user = db.query(User).filter(
        or_(User.username == payload.username, User.email == payload.email)
    ).first()
    if existing_user:
        raise HTTPException(status_code=400, detail="Username or email already exists")

    user = User(
        username=payload.username.strip(),
        email=payload.email.lower(),
        password=hash_password(payload.password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    return {"message": "Account created successfully", "user_id": user.id}


@app.post("/login")
def login(payload: LoginInput, db: Session = Depends(get_db)):
    identifier = payload.identifier.strip()
    user = db.query(User).filter(
        or_(
            User.username == identifier,
            User.email == identifier.lower(),
        )
    ).first()

    if not user or not verify_password(payload.password, user.password):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token = create_access_token(user.id)
    # The frontend stores this JWT and sends it in Authorization headers.
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id": user.id,
            "username": user.username,
            "email": user.email,
        },
    }


@app.post("/reset-password")
def reset_password(payload: ResetPasswordInput, db: Session = Depends(get_db)):
    _validate_password_strength(payload.new_password)
    identifier = payload.identifier.strip()
    user = db.query(User).filter(
        or_(
            User.username == identifier,
            User.email == identifier.lower(),
        )
    ).first()

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user.password = hash_password(payload.new_password)
    db.commit()

    return {"message": "Password reset successfully"}


@app.post("/chats", status_code=status.HTTP_201_CREATED)
def create_chat(
    payload: Optional[CreateChatRequest] = None,
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    chat_row = Chat(
        user_id=user_id,
        title=(payload.title if payload and payload.title else "New Chat")[:255] or "New Chat",
    )
    db.add(chat_row)
    db.commit()
    db.refresh(chat_row)

    return {"chat": _serialize_chat(chat_row)}


@app.post("/upload")
def upload_file(
    file: UploadFile = File(...),
    chat_id: int = Form(...),
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    print(f"[UPLOAD] user_id={user_id}, chat_id={chat_id}, filename={file.filename}")

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Only PDF, DOCX, and TXT files are supported",
        )

    chat_row = db.query(Chat).filter(Chat.id == chat_id, Chat.user_id == user_id).first()
    if not chat_row:
        raise HTTPException(status_code=404, detail="Chat not found")

    file_bytes = file.file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    original_name = file.filename or f"{uuid4().hex}{suffix}"

    try:
        # The uploaded document is chunked, embedded, and merged into this chat's own FAISS index
        # before the document is shown in history. This prevents "uploaded" files with no index.
        chunk_count = process_file(
            user_id=user_id,
            chat_id=chat_row.id,
            filename=original_name,
            file_bytes=file_bytes,
            source_name=original_name,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        print(f"[UPLOAD] indexing failed: {exc}")
        raise HTTPException(
            status_code=500,
            detail="The file uploaded, but indexing failed. Please try a smaller PDF or a text-based PDF.",
        ) from exc

    document = UploadedDocument(
        chat_id=chat_row.id,
        user_id=user_id,
        original_name=original_name,
        mime_type=file.content_type,
        file_size=len(file_bytes),
        file_data=b"",
    )
    db.add(document)
    db.commit()
    db.refresh(document)

    chat_row.updated_at = datetime.now(timezone.utc)
    db.commit()

    return {
        "message": "File uploaded",
        "chat_id": chat_row.id,
        "filename": original_name,
        "chunks_indexed": chunk_count,
        "document": _serialize_document(document),
    }


@app.post("/chat")
def chat(
    payload: ChatRequest,
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    if payload.chat_id is None:
        chat_row = Chat(user_id=user_id, title=_create_chat_title(payload.message))
        db.add(chat_row)
        db.commit()
        db.refresh(chat_row)
    else:
        chat_row = (
            db.query(Chat)
            .options(joinedload(Chat.messages), joinedload(Chat.documents))
            .filter(Chat.id == payload.chat_id, Chat.user_id == user_id)
            .first()
        )
        if not chat_row:
            raise HTTPException(status_code=404, detail="Chat not found")

    previous_messages = (
        db.query(Message)
        .filter(Message.chat_id == chat_row.id)
        .order_by(Message.timestamp.asc(), Message.id.asc())
        .all()
    )
    # Conversation memory comes from the database, not browser state.
    history = [{"role": message.role, "content": message.content} for message in previous_messages[-12:]]

    if not previous_messages:
        chat_row.title = _create_chat_title(payload.message)
        db.commit()

    user_message = Message(chat_id=chat_row.id, role="user", content=payload.message.strip())
    db.add(user_message)
    db.commit()

    try:
        rag_response = get_answer(
            user_id=user_id,
            chat_id=chat_row.id,
            query=payload.message.strip(),
            history=history,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    assistant_message = Message(chat_id=chat_row.id, role="assistant", content=rag_response["answer"])
    db.add(assistant_message)
    chat_row.updated_at = datetime.now(timezone.utc)
    db.commit()

    updated_chat = (
        db.query(Chat)
        .options(joinedload(Chat.messages), joinedload(Chat.documents))
        .filter(Chat.id == chat_row.id, Chat.user_id == user_id)
        .first()
    )

    return {
        "chat_id": chat_row.id,
        "answer": rag_response["answer"],
        "sources": rag_response["sources"],
        "documents": [_serialize_document(document) for document in updated_chat.documents],
        "messages": [_serialize_message(message) for message in updated_chat.messages],
    }


@app.get("/history")
def history(
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    chats = (
        db.query(Chat)
        .options(joinedload(Chat.messages), joinedload(Chat.documents))
        .filter(Chat.user_id == user_id)
        .order_by(Chat.updated_at.desc(), Chat.id.desc())
        .all()
    )
    return {"chats": [_serialize_chat(chat) for chat in chats]}


@app.delete("/chats/{chat_id}")
def delete_chat(
    chat_id: int,
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    chat_row = db.query(Chat).filter(Chat.id == chat_id, Chat.user_id == user_id).first()
    if not chat_row:
        raise HTTPException(status_code=404, detail="Chat not found")

    delete_chat_index(user_id=user_id, chat_id=chat_row.id)
    db.delete(chat_row)
    db.commit()
    return {"message": "Chat deleted"}
