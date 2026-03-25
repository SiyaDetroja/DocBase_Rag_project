from sqlalchemy import Column, DateTime, ForeignKey, Integer, LargeBinary, String, Text, func ,UniqueConstraint
from sqlalchemy.orm import relationship  # adjust import to match your project layout

try:
    from .database import Base
except ImportError:
    from database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, nullable=False, index=True)
    email = Column(String(255), unique=True, nullable=False, index=True)
    password = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    chats = relationship("Chat", back_populates="user", cascade="all, delete-orphan")


class Chat(Base):
    __tablename__ = "chats"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    title = Column(String(255), nullable=False, default="New Chat")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    user = relationship("User", back_populates="chats")
    messages = relationship(
        "Message",
        back_populates="chat",
        cascade="all, delete-orphan",
        order_by="(Message.timestamp, Message.id)",
    )
    documents = relationship(
        "UploadedDocument",
        back_populates="chat",
        cascade="all, delete-orphan",
        order_by="UploadedDocument.created_at",
    )


class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, index=True)
    chat_id = Column(Integer, ForeignKey("chats.id", ondelete="CASCADE"), nullable=False, index=True)
    role = Column(String(20), nullable=False)
    content = Column(Text, nullable=False)
    timestamp = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    chat = relationship("Chat", back_populates="messages")


class UploadedDocument(Base):
    __tablename__ = "uploaded_documents"

    id = Column(Integer, primary_key=True, index=True)
    chat_id = Column(Integer, ForeignKey("chats.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    original_name = Column(String(255), nullable=False)
    mime_type = Column(String(255), nullable=True)
    file_size = Column(Integer, nullable=False, default=0)
    file_data = Column(LargeBinary, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    chat = relationship("Chat", back_populates="documents")
 
class ChatFaissIndex(Base):
    __tablename__ = "chat_faiss_index"
 
    id       = Column(Integer, primary_key=True, index=True)
    user_id  = Column(Integer, nullable=False, index=True)
    chat_id  = Column(Integer, nullable=False, index=True)
    index_data = Column(LargeBinary, nullable=False)   # zipped FAISS files
 
    __table_args__ = (
        UniqueConstraint("user_id", "chat_id", name="uq_user_chat_faiss"),
    )
 




