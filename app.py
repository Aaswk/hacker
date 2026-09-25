"""MVP event API for the human observation pet."""

import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from enum import Enum
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, field_validator


class Event(str, Enum):
    PERSON_ENTER = "PERSON_ENTER"
    DRINKING = "DRINKING"
    STRETCHING = "STRETCHING"
    PERSON_LEFT = "PERSON_LEFT"
    PERSON_RETURNED = "PERSON_RETURNED"
    UNKNOWN = "UNKNOWN"


class PetState(str, Enum):
    IDLE = "IDLE"
    OBSERVING = "OBSERVING"
    THINKING = "THINKING"
    CURIOUS = "CURIOUS"
    ALERT = "ALERT"
    EXCITED = "EXCITED"
    CONFUSED = "CONFUSED"


class HumanEvent(BaseModel):
    subject_id: str
    event: Event
    confidence: float = Field(ge=0, le=1, allow_inf_nan=False)
    timestamp: datetime

    @field_validator("subject_id")
    @classmethod
    def known_subject(cls, value: str) -> str:
        if value != "HUMAN_001":
            raise ValueError("MVP only supports HUMAN_001")
        return value

    @field_validator("timestamp")
    @classmethod
    def timezone_required(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("timestamp must include a timezone")
        return value


class EventResponse(BaseModel):
    observation_id: int
    event: Event
    pet_state: PetState
    message: str


class Observation(EventResponse):
    subject_id: str
    confidence: float
    timestamp: datetime


class SubjectSummary(BaseModel):
    subject_id: str
    total_observations: int
    event_counts: dict[str, int]


class SpeciesCard(BaseModel):
    subject_id: str
    event_counts: dict[str, int]
    summary: str


NARRATIVE = {
    Event.PERSON_ENTER: (PetState.EXCITED, "检测到未知碳基生命体。开始建立观察档案。"),
    Event.DRINKING: (PetState.CURIOUS, "目标正在为内部海洋补充液体。"),
    Event.STRETCHING: (PetState.ALERT, "目标正在扩大身体面积，原因有待观察。"),
    Event.PERSON_LEFT: (PetState.ALERT, "观察对象离开了视野。"),
    Event.PERSON_RETURNED: (PetState.EXCITED, "HUMAN #001 再次出现。"),
    Event.UNKNOWN: (PetState.CONFUSED, "记录到尚未理解的行为。"),
}


def database_path() -> str:
    return os.getenv("OBSERVATION_DB", str(Path(__file__).with_name("observations.sqlite3")))


@contextmanager
def db():
    connection = sqlite3.connect(database_path())
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("""CREATE TABLE IF NOT EXISTS observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject_id TEXT NOT NULL,
            event TEXT NOT NULL,
            confidence REAL NOT NULL,
            timestamp TEXT NOT NULL,
            pet_state TEXT NOT NULL,
            message TEXT NOT NULL
        )""")
        yield connection
        connection.commit()
    finally:
        connection.close()


app = FastAPI(title="Human Observer MVP API")
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Human Observer MVP API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/events", response_model=EventResponse, status_code=201)
def create_event(payload: HumanEvent):
    # Deterministic narration keeps the demo usable without an API key.
    # The LLM adapter can replace this mapping without changing the contract.
    pet_state, message = NARRATIVE[payload.event]
    with db() as connection:
        cursor = connection.execute(
            "INSERT INTO observations (subject_id,event,confidence,timestamp,pet_state,message) VALUES (?,?,?,?,?,?)",
            (payload.subject_id, payload.event.value, payload.confidence,
             payload.timestamp.isoformat(), pet_state.value, message),
        )
        observation_id = cursor.lastrowid
    return EventResponse(observation_id=observation_id, event=payload.event,
                         pet_state=pet_state, message=message)


@app.get("/observations", response_model=list[Observation])
def list_observations():
    with db() as connection:
        rows = connection.execute("SELECT * FROM observations ORDER BY id DESC").fetchall()
    return [Observation(observation_id=row["id"], **{key: row[key] for key in
            ("subject_id", "event", "confidence", "timestamp", "pet_state", "message")})
            for row in rows]


def counts(subject_id: str) -> dict[str, int]:
    with db() as connection:
        rows = connection.execute(
            "SELECT event, COUNT(*) AS count FROM observations WHERE subject_id=? GROUP BY event",
            (subject_id,),
        ).fetchall()
    return {row["event"]: row["count"] for row in rows}


@app.get("/subjects/{subject_id}", response_model=SubjectSummary)
def get_subject(subject_id: str):
    if subject_id != "HUMAN_001":
        raise HTTPException(status_code=404, detail="Unknown subject")
    event_counts = counts(subject_id)
    return SubjectSummary(subject_id=subject_id, total_observations=sum(event_counts.values()),
                          event_counts=event_counts)


@app.get("/species-card", response_model=SpeciesCard)
def get_species_card():
    event_counts = counts("HUMAN_001")
    total = sum(event_counts.values())
    summary = f"已记录 {total} 次观察。该生物持续表现出值得研究的日常行为。" if total else ""
    return SpeciesCard(subject_id="HUMAN_001", event_counts=event_counts, summary=summary)