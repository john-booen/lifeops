import { addDays } from "../../date";
import { isContextSourcePath } from "../../sourceReferences";
import { isLearningDate, isLearningTrackId, type LearningTrackId } from "./model";

export const QUIZ_INTERVALS = [1, 3, 7, 15, 30] as const;
export interface QuizAttempt { date: string; userAnswer: string; correct: boolean; explanation: string }
export interface QuizCard {
  id: string;
  trackId: LearningTrackId;
  question: string;
  answer: string;
  sourcePath: string;
  sourceQuote: string;
  ease: number;
  intervalDays: number;
  due: string;
  history: QuizAttempt[];
}
export interface QuizDocument {
  version: 1;
  cards: QuizCard[];
  active?: { date: string; cardIds: string[] };
}

export const quizText = (value: unknown, max: number): value is string =>
  typeof value === "string" && !!value.trim() && value.length <= max;

export function validQuizDocument(value: unknown): value is QuizDocument {
  const doc = value as QuizDocument | undefined;
  if (!doc || doc.version !== 1 || !Array.isArray(doc.cards) || doc.cards.some(card =>
    !card || !quizText(card.id, 120) || !isLearningTrackId(card.trackId) || !quizText(card.question, 300)
    || !quizText(card.answer, 1000) || !isContextSourcePath(card.sourcePath) || !quizText(card.sourceQuote, 600)
    || !Number.isInteger(card.ease) || card.ease < 1 || card.ease > 3
    || ![0, ...QUIZ_INTERVALS].includes(card.intervalDays) || !isLearningDate(card.due)
    || !Array.isArray(card.history) || card.history.some(attempt => !attempt || !isLearningDate(attempt.date)
      || !quizText(attempt.userAnswer, 1200) || typeof attempt.correct !== "boolean" || !quizText(attempt.explanation, 1000)))) return false;
  const ids = new Set(doc.cards.map(card => card.id));
  return ids.size === doc.cards.length && (doc.active === undefined || !!doc.active && isLearningDate(doc.active.date)
    && Array.isArray(doc.active.cardIds) && doc.active.cardIds.length <= 12 && doc.active.cardIds.every(id => ids.has(id))
    && new Set(doc.active.cardIds).size === doc.active.cardIds.length);
}

export function applyQuizGrade(card: QuizCard, attempt: QuizAttempt): QuizCard {
  const index = QUIZ_INTERVALS.findIndex(days => days === card.intervalDays);
  const intervalDays = attempt.correct ? QUIZ_INTERVALS[Math.min(index + 1, QUIZ_INTERVALS.length - 1)] : 1;
  const ease = attempt.correct ? card.ease : Math.max(1, card.ease - 1);
  return { ...card, ease, intervalDays, due: addDays(attempt.date, intervalDays), history: [...card.history, attempt] };
}
