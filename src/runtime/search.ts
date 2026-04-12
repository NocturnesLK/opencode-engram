/**
 * search.ts - Search Infrastructure (Phase 1 + Phase 2 + Phase 3)
 *
 * This module provides the search infrastructure for history_search.
 *
 * Phase 1 (established):
 * - Search document model (part-level indexing)
 * - Cache entry structure
 * - Cache boundary skeleton
 *
 * Phase 2 (established):
 * - Orama database initialization with Mandarin tokenizer
 * - Document extraction pipeline (text/reasoning/tool content + input header)
 * - Index build layer
 * - Session-level cache read/write integration
 *
 * Phase 3 (current):
 * - Search execution (exact/fulltext)
 * - Hit aggregation and snippet generation
 * - Result grouping by message with relevance-first ordering
 */

import { create, insertMultiple, search, type Orama } from "@orama/orama";
import { createTokenizer } from "@orama/tokenizers/mandarin";

import {
  composeContentWithToolInputSignature,
} from "../common/common.ts";
import type { SearchPartType } from "../domain/types.ts";
import type {
  NormalizedPart,
  NormalizedTextPart,
  NormalizedReasoningPart,
  NormalizedToolPart,
} from "../domain/types.ts";

// =============================================================================
// Search Document Model
// =============================================================================

/**
 * A single searchable document representing a part within a message.
 *
 * This is the indexing unit for Orama. Each part that contains searchable
 * content is converted into a SearchDocument for indexing.
 *
 * Fields:
 * - id: unique identifier (part_id)
 * - messageId: parent message identifier
 * - type: part type (text, reasoning, tool)
 * - content: searchable text content (tool docs include a JSON input header)
 * - toolName: present only for tool parts
 * - time: message creation time (for tie-breaking)
 */
export interface SearchDocument {
  id: string;
  messageId: string;
  type: SearchPartType;
  content: string;
  toolName?: string;
  time: number | undefined;
}

/**
 * Message metadata used for grouping search results.
 */
export interface SearchMessageMeta {
  id: string;
  role: "user" | "assistant";
  turn: number;
}

// =============================================================================
// Orama Schema and Database Type
// =============================================================================

/**
 * Orama schema for search documents.
 *
 * Maps SearchDocument fields to Orama schema types.
 */
const searchSchema = {
  id: "string",
  messageId: "string",
  type: "string",
  content: "string",
  toolName: "string",
  time: "number",
} as const;

/**
 * Orama database type for search documents.
 */
export type SearchOramaDb = Orama<typeof searchSchema>;

// =============================================================================
// Search Cache Entry
// =============================================================================

/**
 * Cache entry for a session's search index.
 *
 * Contains the built search documents, Orama database instance, and
 * fingerprint for invalidation.
 */
export interface SearchCacheEntry {
  /** Session ID this cache belongs to */
  sessionId: string;

  /** Session fingerprint for invalidation */
  fingerprint: string | undefined;

  /** Timestamp when this cache was created */
  createdAt: number;

  /** Array of searchable documents (retained for debugging/inspection) */
  documents: SearchDocument[];

  /** Orama database instance for search execution */
  db: SearchOramaDb;

  /** Message metadata map for result grouping (messageId -> meta) */
  messageMeta: Map<string, SearchMessageMeta>;
}

// =============================================================================
// Search Cache (Session-Level Memory Cache)
// =============================================================================

const searchCacheMaxEntries = 32;
const searchCache = new Map<string, SearchCacheEntry>();

/**
 * Prune old entries from the search cache.
 *
 * Uses LRU-like eviction: oldest entries (by insertion order) are removed first.
 */
function pruneSearchCache(maxEntries: number): void {
  while (searchCache.size > maxEntries) {
    const oldest = searchCache.keys().next().value;
    if (oldest === undefined) break;
    searchCache.delete(oldest);
  }
}

/**
 * Get a search cache entry if valid.
 *
 * Validates against:
 * - Session fingerprint (invalidates when session is modified)
 * - TTL (invalidates when cache is too old)
 *
 * @param sessionId Session to look up
 * @param fingerprint Current session fingerprint
 * @param ttlMs Maximum age in milliseconds
 * @returns Cache entry if valid, undefined otherwise
 */
export function getSearchCacheEntry(
  sessionId: string,
  fingerprint: string | undefined,
  ttlMs: number,
): SearchCacheEntry | undefined {
  const entry = searchCache.get(sessionId);
  if (!entry) return undefined;

  // Fingerprint mismatch - session has been modified
  if (fingerprint !== entry.fingerprint) {
    searchCache.delete(sessionId);
    return undefined;
  }

  // TTL expired
  const age = Date.now() - entry.createdAt;
  if (age > ttlMs) {
    searchCache.delete(sessionId);
    return undefined;
  }

  // Refresh insertion order (LRU behavior)
  searchCache.delete(sessionId);
  searchCache.set(sessionId, entry);
  return entry;
}

/**
 * Store a search cache entry.
 *
 * Overwrites any existing entry for the session.
 * Automatically prunes old entries to stay within limits.
 *
 * @param entry Cache entry to store
 */
export function setSearchCacheEntry(entry: SearchCacheEntry): void {
  searchCache.delete(entry.sessionId);
  searchCache.set(entry.sessionId, entry);
  pruneSearchCache(searchCacheMaxEntries);
}

// =============================================================================
// In-Flight Build Coalescing
// =============================================================================

/**
 * In-flight cache build promises for request coalescing.
 *
 * Keyed by (sessionId, fingerprint) so callers never join a build that started
 * with a stale session fingerprint.
 */
const searchCacheInflight = new Map<string, Promise<SearchCacheEntry>>();

function searchInflightKey(sessionId: string, fingerprint: string | undefined): string {
  return JSON.stringify([sessionId, fingerprint ?? null]);
}

/**
 * Get an in-flight cache build promise if one exists.
 */
export function getSearchCacheInflight(
  sessionId: string,
  fingerprint: string | undefined,
): Promise<SearchCacheEntry> | undefined {
  return searchCacheInflight.get(searchInflightKey(sessionId, fingerprint));
}

/**
 * Register an in-flight cache build promise.
 */
export function setSearchCacheInflight(
  sessionId: string,
  fingerprint: string | undefined,
  promise: Promise<SearchCacheEntry>,
): void {
  searchCacheInflight.set(searchInflightKey(sessionId, fingerprint), promise);
}

/**
 * Clear an in-flight cache build registration.
 *
 * Only clears if the registered promise matches (guard against races).
 */
export function clearSearchCacheInflight(
  sessionId: string,
  fingerprint: string | undefined,
  promise: Promise<SearchCacheEntry>,
): void {
  const key = searchInflightKey(sessionId, fingerprint);
  if (searchCacheInflight.get(key) === promise) {
    searchCacheInflight.delete(key);
  }
}

// =============================================================================
// Search Input Types (Validated)
// =============================================================================

/**
 * Validated search input parameters.
 *
 * All fields are validated and normalized by the time they reach this type.
 */
export interface SearchInput {
  /** Normalized query string (non-empty, within length limit) */
  query: string;

  /** Search mode: false = fulltext/BM25, true = literal substring match */
  literal: boolean;

  /** Maximum messages to return (1-10) */
  limit: number;

  /** Allowed searchable part types */
  types: SearchPartType[];
}

// =============================================================================
// Search Execution Types
// =============================================================================

/**
 * A single raw hit from Orama search.
 *
 * Used internally before grouping by message.
 */
interface RawSearchHit {
  documentId: string;
  messageId: string;
  type: SearchPartType;
  toolName?: string;
  content: string;
  score: number;
  time: number;
}

interface RawSearchResult {
  totalHits: number;
  hits: RawSearchHit[];
}

/**
 * Search execution result after grouping and snippet generation.
 *
 * - totalHits: total unique hits found before message limiting
 * - hits: grouped hits selected for returned messages with snippets
 */
export interface SearchExecutionResult {
  totalHits: number;
  hits: Array<{
    documentId: string;
    messageId: string;
    type: SearchPartType;
    toolName?: string;
    snippets: string[];
  }>;
}

export interface ToolSearchVisibility {
  visibleToolInputs: ReadonlySet<string>;
  visibleToolOutputs: ReadonlySet<string>;
}

// =============================================================================
// Document Extraction Pipeline
// =============================================================================

/**
 * Check if a text part should be included in search.
 *
 * Excludes:
 * - Ignored parts
 * - Empty/whitespace-only content
 */
function isSearchableTextPart(part: NormalizedTextPart): boolean {
  if (part.ignored) return false;
  return part.text.trim().length > 0;
}

/**
 * Check if a reasoning part should be included in search.
 *
 * Excludes:
 * - Empty/whitespace-only content
 */
function isSearchableReasoningPart(part: NormalizedReasoningPart): boolean {
  return part.text.trim().length > 0;
}

/**
 * Check if a tool part should be included in search.
 *
 * Tool parts are searchable when they have either:
 * - structured input parameters, or
 * - output content
 */
function isSearchableToolPart(part: NormalizedToolPart): boolean {
  if (Object.keys(part.input).length > 0) {
    return true;
  }

  return part.content !== undefined && part.content.trim().length > 0;
}

function shouldSearchToolInput(
  part: NormalizedToolPart,
  toolVisibility: ToolSearchVisibility | undefined,
): boolean {
  if (!toolVisibility) {
    return true;
  }
  return toolVisibility.visibleToolInputs.has(part.tool);
}

function shouldSearchToolOutput(
  part: NormalizedToolPart,
  toolVisibility: ToolSearchVisibility | undefined,
): boolean {
  if (!toolVisibility) {
    return true;
  }
  return toolVisibility.visibleToolOutputs.has(part.tool);
}

function isSearchableVisibleToolPart(
  part: NormalizedToolPart,
  toolVisibility: ToolSearchVisibility | undefined,
): boolean {
  const canSearchInput = shouldSearchToolInput(part, toolVisibility);
  const canSearchOutput = shouldSearchToolOutput(part, toolVisibility);

  if (canSearchInput && Object.keys(part.input).length > 0) {
    return true;
  }

  if (canSearchOutput && part.content !== undefined && part.content.trim().length > 0) {
    return true;
  }

  return false;
}

/**
 * Extract a search document from a text part.
 */
function extractTextDocument(
  part: NormalizedTextPart,
  time: number | undefined,
): SearchDocument {
  return {
    id: part.partId,
    messageId: part.messageId,
    type: "text",
    content: part.text,
    time,
  };
}

/**
 * Extract a search document from a reasoning part.
 */
function extractReasoningDocument(
  part: NormalizedReasoningPart,
  time: number | undefined,
): SearchDocument {
  return {
    id: part.partId,
    messageId: part.messageId,
    type: "reasoning",
    content: part.text,
    time,
  };
}

/**
 * Extract a search document from a tool part.
 *
 * The searchable content is prefixed with a tool-signature header containing
 * the tool input so search can match parameter values.
 */
function extractToolDocument(
  part: NormalizedToolPart,
  time: number | undefined,
  toolVisibility: ToolSearchVisibility | undefined,
): SearchDocument {
  const input = shouldSearchToolInput(part, toolVisibility)
    ? part.input
    : undefined;
  const output = shouldSearchToolOutput(part, toolVisibility)
    ? part.content
    : undefined;
  const content = composeContentWithToolInputSignature(
    part.tool,
    input,
    output,
  );
  return {
    id: part.partId,
    messageId: part.messageId,
    type: "tool",
    content: content ?? "",
    toolName: part.tool,
    time,
  };
}

/**
 * Extract search documents from normalized parts.
 *
 * Extracts from:
 * - text (user or assistant text content)
 * - reasoning (assistant reasoning content)
 * - tool (input header + output content)
 *
 * Does NOT extract from image/file attachments.
 *
 * @param parts Normalized parts from a message
 * @param messageTime Message creation time
 * @returns Array of search documents
 */
export function extractSearchDocuments(
  parts: NormalizedPart[],
  messageTime: number | undefined,
  toolVisibility?: ToolSearchVisibility,
): SearchDocument[] {
  const documents: SearchDocument[] = [];

  for (const part of parts) {
    switch (part.type) {
      case "text":
        if (isSearchableTextPart(part)) {
          documents.push(extractTextDocument(part, messageTime));
        }
        break;
      case "reasoning":
        if (isSearchableReasoningPart(part)) {
          documents.push(extractReasoningDocument(part, messageTime));
        }
        break;
      case "tool":
        if (isSearchableToolPart(part) && isSearchableVisibleToolPart(part, toolVisibility)) {
          documents.push(extractToolDocument(part, messageTime, toolVisibility));
        }
        break;
      // image/file parts are intentionally not searchable
      case "image":
      case "file":
        break;
    }
  }

  return documents;
}

// =============================================================================
// Orama Database Initialization
// =============================================================================

/**
 * Create a new Orama database instance with Mandarin tokenizer.
 *
 * The Mandarin tokenizer also handles English and other languages,
 * making it suitable for mixed-language content.
 */
export async function createSearchDatabase(): Promise<SearchOramaDb> {
  const tokenizer = await createTokenizer();
  return create({
    schema: searchSchema,
    components: {
      tokenizer,
    },
  });
}

/**
 * Internal document shape for Orama insertion.
 *
 * Matches the searchSchema definition for type-safe insertion.
 * Optional fields must use empty string as Orama requires all
 * schema fields to be present.
 */
interface OramaSearchDocInsert {
  id: string;
  messageId: string;
  type: string;
  content: string;
  toolName: string;
  time: number;
}

/**
 * Convert SearchDocument to Orama insert format.
 *
 * Handles optional fields:
 * - toolName: defaults to empty string
 * - time: defaults to -1 to avoid bad tie-break behavior when mixed with real timestamps
 *         (0 would sort equivalently to epoch, -1 ensures missing times sort last)
 */
function toOramaDocument(doc: SearchDocument): OramaSearchDocInsert {
  return {
    id: doc.id,
    messageId: doc.messageId,
    type: doc.type,
    content: doc.content,
    toolName: doc.toolName ?? "",
    time: doc.time ?? -1,
  };
}

/**
 * Build the search index from extracted documents.
 *
 * Creates a new Orama database and inserts all documents.
 *
 * @param documents Array of search documents to index
 * @returns Orama database instance with indexed documents
 */
export async function buildSearchIndex(
  documents: SearchDocument[],
): Promise<SearchOramaDb> {
  const db = await createSearchDatabase();

  if (documents.length > 0) {
    const oramaDocuments = documents.map(toOramaDocument);
    await insertMultiple(db, oramaDocuments, 500);
  }

  return db;
}

// =============================================================================
// Full Cache Build Pipeline
// =============================================================================

/**
 * Message bundle input for cache building.
 *
 * This type represents the message data needed to build the search cache.
 * It's aligned with the MessageBundle type used in runtime.ts but defined
 * independently to avoid circular dependencies.
 */
export interface SearchMessageInput {
  id: string;
  role: "user" | "assistant";
  time: number | undefined;
  parts: NormalizedPart[];
  turn: number;
}

/**
 * Build a complete search cache entry from messages.
 *
 * This is the main entry point for Phase 2 cache building.
 * It orchestrates:
 * 1. Document extraction from all messages
 * 2. Message metadata collection
 * 3. Orama database initialization and indexing
 * 4. Cache entry assembly
 *
 * @param sessionId Session identifier
 * @param fingerprint Session fingerprint for invalidation
 * @param messages Array of message inputs with normalized parts and turn numbers
 * @returns Complete cache entry ready for storage
 */
export async function buildSearchCacheEntry(
  sessionId: string,
  fingerprint: string | undefined,
  messages: SearchMessageInput[],
  toolVisibility?: ToolSearchVisibility,
): Promise<SearchCacheEntry> {
  // 1. Extract documents from all messages
  const allDocuments: SearchDocument[] = [];
  for (const msg of messages) {
    const docs = extractSearchDocuments(msg.parts, msg.time, toolVisibility);
    allDocuments.push(...docs);
  }

  // 2. Collect message metadata
  const messageMeta = new Map<string, SearchMessageMeta>();
  for (const msg of messages) {
    messageMeta.set(msg.id, {
      id: msg.id,
      role: msg.role,
      turn: msg.turn,
    });
  }

  // 3. Build the Orama index
  const db = await buildSearchIndex(allDocuments);

  // 4. Assemble and return the cache entry
  return {
    sessionId,
    fingerprint,
    createdAt: Date.now(),
    documents: allDocuments,
    db,
    messageMeta,
  };
}

// =============================================================================
// Snippet Generation
// =============================================================================

/**
 * Generate a single snippet around a match position.
 *
 * Creates a window of text around the match position, trimming to word
 * boundaries where possible and adding ellipsis markers.
 *
 * @param content Full content string
 * @param matchStart Start position of the match
 * @param matchEnd End position of the match
 * @param snippetLength Maximum snippet length
 * @returns Snippet string with ellipsis markers
 */
function generateSnippetWindow(
  content: string,
  matchStart: number,
  matchEnd: number,
  snippetLength: number,
): string {
  const contextBefore = Math.floor((snippetLength - (matchEnd - matchStart)) / 2);
  const contextAfter = snippetLength - (matchEnd - matchStart) - contextBefore;

  let start = Math.max(0, matchStart - contextBefore);
  let end = Math.min(content.length, matchEnd + contextAfter);

  // Try to align to word boundaries
  if (start > 0) {
    const wordBoundary = content.lastIndexOf(" ", start + 10);
    if (wordBoundary > start - 20 && wordBoundary >= 0) {
      start = wordBoundary + 1;
    }
  }
  if (end < content.length) {
    const wordBoundary = content.indexOf(" ", end - 10);
    if (wordBoundary > 0 && wordBoundary < end + 20) {
      end = wordBoundary;
    }
  }

  let snippet = content.slice(start, end).trim();

  // Add ellipsis markers
  if (start > 0) {
    snippet = "..." + snippet;
  }
  if (end < content.length) {
    snippet = snippet + "...";
  }

  return hardCapSnippet(snippet, snippetLength);
}

/**
 * Enforce a hard snippet max length, including ellipsis markers.
 */
function hardCapSnippet(snippet: string, snippetLength: number): string {
  const trimmed = snippet.trim();
  if (trimmed.length <= snippetLength) {
    return trimmed;
  }

  if (snippetLength <= 3) {
    return "...".slice(0, snippetLength);
  }

  return `${trimmed.slice(0, snippetLength - 3).trimEnd()}...`;
}

/**
 * Generate a fallback snippet from the start of content.
 */
function generateStartSnippet(content: string, snippetLength: number): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.length <= snippetLength) {
    return trimmed;
  }

  if (snippetLength <= 3) {
    return "...".slice(0, snippetLength);
  }

  return `${trimmed.slice(0, snippetLength - 3).trimEnd()}...`;
}

/**
 * Find all literal occurrences of a term in content (case-sensitive).
 *
 * @param content Content to search
 * @param term Term to find
 * @returns Array of {start, end} positions
 */
function findLiteralPositions(
  content: string,
  term: string,
  caseInsensitive = false,
): Array<{ start: number; end: number }> {
  const positions: Array<{ start: number; end: number }> = [];
  const searchContent = caseInsensitive ? content.toLowerCase() : content;
  const searchTerm = caseInsensitive ? term.toLowerCase() : term;
  let pos = 0;

  while (pos < searchContent.length) {
    const found = searchContent.indexOf(searchTerm, pos);
    if (found === -1) break;
    positions.push({ start: found, end: found + searchTerm.length });
    pos = found + 1;
  }

  return positions;
}

function tokenizeSnippetTerms(tokenizer: SearchOramaDb["tokenizer"], query: string): string[] {
  const rawTerms = tokenizer.tokenize(query, tokenizer.language);
  const terms: string[] = [];
  const seen = new Set<string>();

  for (const term of rawTerms) {
    const normalized = term.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    terms.push(normalized);
  }

  return terms;
}

type SnippetCandidate = {
  start: number;
  end: number;
  priority: number;
  secondary: number;
};

function compareSnippetCandidates(
  a: SnippetCandidate,
  b: SnippetCandidate,
): number {
  const priorityDiff = b.priority - a.priority;
  if (Math.abs(priorityDiff) > 0.0001) {
    return priorityDiff;
  }

  const secondaryDiff = a.secondary - b.secondary;
  if (secondaryDiff !== 0) {
    return secondaryDiff;
  }

  const startDiff = a.start - b.start;
  if (startDiff !== 0) {
    return startDiff;
  }

  return a.end - b.end;
}

function collectTopSnippets(
  content: string,
  candidates: SnippetCandidate[],
  snippetLength: number,
  maxSnippets: number,
): string[] {
  const snippets: string[] = [];
  const usedRanges: Array<{ start: number; end: number }> = [];

  for (const candidate of [...candidates].sort(compareSnippetCandidates)) {
    if (snippets.length >= maxSnippets) {
      break;
    }

    const overlaps = usedRanges.some(
      (range) => candidate.start < range.end && candidate.end > range.start,
    );
    if (overlaps) {
      continue;
    }

    const snippet = generateSnippetWindow(
      content,
      candidate.start,
      candidate.end,
      snippetLength,
    );
    if (!snippet) {
      continue;
    }

    snippets.push(snippet);
    usedRanges.push({
      start: Math.max(0, candidate.start - snippetLength),
      end: Math.min(content.length, candidate.end + snippetLength),
    });
  }

  return snippets;
}

/**
 * Generate snippet array for a document match.
 *
 * For exact mode: ranks literal occurrences by earliest position.
 * For fulltext mode: ranks term matches by term specificity, then query order,
 * then document position.
 *
 * @param content Document content
 * @param query Search query
 * @param exact Whether exact mode was used
 * @param snippetLength Maximum snippet length
 * @param maxSnippetsPerMessage Maximum number of snippets to return for this hit
 * @returns Array of snippet strings (may be empty if no good snippets found)
 */
export function generateSnippets(
  content: string,
  query: string,
  exact: boolean,
  snippetLength: number,
  maxSnippetsPerMessage: number,
  fulltextQueryTerms?: string[],
): string[] {
  if (!content || content.trim().length === 0) {
    return [];
  }

  if (exact) {
    // Exact mode: rank literal substring occurrences by earliest position.
    const positions = findLiteralPositions(content, query, true);
    if (positions.length === 0) {
      // Fallback: return start of content
      const snippet = generateStartSnippet(content, snippetLength);
      return snippet ? [snippet] : [];
    }

    const candidates = positions.map((pos) => ({
      start: pos.start,
      end: pos.end,
      priority: -pos.start,
      secondary: pos.end,
    }));

    const snippets = collectTopSnippets(
      content,
      candidates,
      snippetLength,
      maxSnippetsPerMessage,
    );
    return snippets.length > 0 ? snippets : [];
  }

  // Fulltext mode: rank snippets by term specificity, then term order, then position.
  const queryTerms = fulltextQueryTerms ?? query
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);

  const seenTerms = new Map<string, { term: string; index: number }>();
  for (let i = 0; i < queryTerms.length; i += 1) {
    const term = queryTerms[i];
    if (!seenTerms.has(term)) {
      seenTerms.set(term, { term, index: i });
    }
  }

  const terms = Array.from(seenTerms.values());

  const candidates: SnippetCandidate[] = [];
  for (const entry of terms) {
    const positions = findLiteralPositions(content, entry.term);
    for (const pos of positions) {
      candidates.push({
        start: pos.start,
        end: pos.end,
        priority: entry.term.length * 1000 - entry.index,
        secondary: pos.start,
      });
    }
  }

  if (candidates.length > 0) {
    const snippets = collectTopSnippets(
      content,
      candidates,
      snippetLength,
      maxSnippetsPerMessage,
    );
    if (snippets.length > 0) {
      return snippets;
    }
  }

  // No terms found, return start of content.
  const snippet = generateStartSnippet(content, snippetLength);
  return snippet ? [snippet] : [];
}

// =============================================================================
// Search Execution
// =============================================================================

/**
 * Convert Orama search results to raw hits.
 */
function toRawHits(
  oramaHits: Array<{
    id: string;
    score: number;
    document: OramaSearchDocInsert;
  }>,
): RawSearchHit[] {
  return oramaHits.map((hit) => ({
    documentId: hit.document.id,
    messageId: hit.document.messageId,
    type: hit.document.type as SearchPartType,
    toolName: hit.document.toolName || undefined,
    content: hit.document.content,
    score: hit.score,
    time: hit.document.time,
  }));
}

function scoreSubstringMatchPosition(position: number): number {
  return 1 / (position + 1);
}

function compareRawHitsByPriority(a: RawSearchHit, b: RawSearchHit): number {
  const scoreDiff = b.score - a.score;
  if (Math.abs(scoreDiff) > 0.0001) {
    return scoreDiff;
  }

  const timeDiff = b.time - a.time;
  if (timeDiff !== 0) {
    return timeDiff;
  }

  const messageDiff = a.messageId.localeCompare(b.messageId);
  if (messageDiff !== 0) {
    return messageDiff;
  }

  return a.documentId.localeCompare(b.documentId);
}

/**
 * Score boost applied to BM25 hits that contain the query as an exact
 * case-insensitive substring. Ensures documents with verbatim matches
 * always rank above documents that only match individual tokenized terms.
 *
 * The value is large enough to dominate any BM25 score while preserving
 * relative BM25 ordering among boosted hits (BM25 score acts as tiebreaker).
 */
const exactSubstringBoostScore = 1e6;

/**
 * Apply exact substring boost to fulltext/BM25 search hits.
 *
 * Hits whose content contains the full query as a contiguous substring
 * (case-insensitive) receive a large score boost.
 */
function applyExactSubstringBoost(
  hits: RawSearchHit[],
  query: string,
): void {
  const lowerQuery = query.toLowerCase();
  for (const hit of hits) {
    if (hit.content.toLowerCase().includes(lowerQuery)) {
      hit.score += exactSubstringBoostScore;
    }
  }
}

/**
 * Execute exact search with literal substring matching.
 *
 * This path is independent from Orama and uses direct substring checks
 * on cached content documents for predictable Unicode behavior.
 * Matching is case-insensitive.
 */
async function executeExactSearch(
  documents: SearchDocument[],
  query: string,
  allowedTypes: ReadonlySet<SearchPartType>,
): Promise<RawSearchResult> {
  if (query.length === 0) {
    return { totalHits: 0, hits: [] };
  }

  const lowerQuery = query.toLowerCase();
  const hits: RawSearchHit[] = [];
  let totalHits = 0;

  for (const doc of documents) {
    if (!allowedTypes.has(doc.type)) {
      continue;
    }

    if (lowerQuery.length > doc.content.length) {
      continue;
    }

    const position = doc.content.toLowerCase().indexOf(lowerQuery);
    if (position === -1) {
      continue;
    }

    totalHits += 1;
    hits.push({
      documentId: doc.id,
      messageId: doc.messageId,
      type: doc.type,
      toolName: doc.toolName,
      content: doc.content,
      score: scoreSubstringMatchPosition(position),
      time: doc.time ?? -1,
    });
  }

  if (totalHits === 0) {
    return { totalHits: 0, hits: [] };
  }

  hits.sort(compareRawHitsByPriority);

  return {
    totalHits,
    hits,
  };
}

/**
 * Execute Orama search with fulltext/BM25 mode.
 *
 * Uses Orama's default BM25 ranking for relevance-based results,
 * paging through all matches to preserve complete message grouping.
 */
async function executeFulltextSearch(
  db: SearchOramaDb,
  query: string,
  types: SearchPartType[],
): Promise<RawSearchResult> {
  const pageSize = 500;
  let offset = 0;
  let totalHits = 0;
  const rawHits: RawSearchHit[] = [];

  while (true) {
    const result = await search(db, {
      term: query,
      properties: ["content"],
      where: {
        type: types.length === 1 ? types[0]! : types,
      },
      limit: pageSize,
      offset,
    });

    if (offset === 0) {
      totalHits = result.count;
    }

    const pageHits = toRawHits(result.hits as Array<{
      id: string;
      score: number;
      document: OramaSearchDocInsert;
    }>);

    if (pageHits.length === 0) {
      break;
    }

    rawHits.push(...pageHits);
    offset += pageHits.length;

    if (offset >= totalHits) {
      break;
    }
  }

  rawHits.sort(compareRawHitsByPriority);

  return {
    totalHits,
    hits: rawHits,
  };
}

/**
 * Group raw hits by message and aggregate.
 *
 * Groups hits by message ID, preserving per-message hit ordering by score,
 * and orders messages by the best hit score within each message.
 *
 * @param rawHits Array of raw hits (already sorted by relevance)
 * @param messageMeta Message metadata map
 * @returns Grouped hits with message metadata
 */
function groupHitsByMessage(
  rawHits: RawSearchHit[],
  messageMeta: Map<string, SearchMessageMeta>,
): Map<
  string,
  {
    meta: SearchMessageMeta;
    bestScore: number;
    bestTime: number;
    hits: RawSearchHit[];
  }
> {
  const groups = new Map<
    string,
    {
      meta: SearchMessageMeta;
      bestScore: number;
      bestTime: number;
      hits: RawSearchHit[];
    }
  >();

  for (const hit of rawHits) {
    const meta = messageMeta.get(hit.messageId);
    if (!meta) continue; // Skip orphaned hits

    const existing = groups.get(hit.messageId);
    if (existing) {
      existing.hits.push(hit);
      if (hit.score > existing.bestScore) {
        existing.bestScore = hit.score;
      }
      // Use the most recent time for tie-breaking (higher = newer)
      if (hit.time > existing.bestTime) {
        existing.bestTime = hit.time;
      }
    } else {
      groups.set(hit.messageId, {
        meta,
        bestScore: hit.score,
        bestTime: hit.time,
        hits: [hit],
      });
    }
  }

  return groups;
}

/**
 * Sort message groups by relevance (score descending, then time descending).
 */
function sortMessageGroups(
  groups: Map<
    string,
    {
      meta: SearchMessageMeta;
      bestScore: number;
      bestTime: number;
      hits: RawSearchHit[];
    }
  >,
): Array<{
  meta: SearchMessageMeta;
  hits: RawSearchHit[];
}> {
  return Array.from(groups.values()).sort((a, b) => {
    // Primary: score descending
    const scoreDiff = b.bestScore - a.bestScore;
    if (Math.abs(scoreDiff) > 0.0001) {
      return scoreDiff;
    }
    // Secondary: time descending (newer first)
    return b.bestTime - a.bestTime;
  });
}

/**
 * Execute search against a cache entry.
 *
 * Handles:
 * - exact/fulltext mode routing
 * - Result grouping by message
 * - Relevance-first ordering
 * - Snippet generation
 *
 * @param cache Search cache entry with Orama database
 * @param input Validated search parameters
 * @param snippetLength Snippet length from config
 * @param maxSnippetsPerMessage Maximum snippets to include per hit
 * @returns Search execution result with grouped hits
 */
export async function executeSearch(
  cache: SearchCacheEntry,
  input: SearchInput,
  snippetLength: number,
  maxSnippetsPerMessage: number,
): Promise<SearchExecutionResult> {
  const allowedTypes = new Set(input.types);
  const fulltextQueryTerms = input.literal
    ? undefined
    : tokenizeSnippetTerms(cache.db.tokenizer, input.query);

  // 1. Execute appropriate search mode.
  const searchResult = input.literal
    ? await executeExactSearch(cache.documents, input.query, allowedTypes)
    : await executeFulltextSearch(cache.db, input.query, input.types);

  // Boost fulltext hits containing the exact query as a substring.
  if (!input.literal && searchResult.hits.length > 0) {
    applyExactSubstringBoost(searchResult.hits, input.query);
  }

  if (searchResult.totalHits === 0 || searchResult.hits.length === 0) {
    return { totalHits: 0, hits: [] };
  }

  // 2. Group hits by message
  const groups = groupHitsByMessage(searchResult.hits, cache.messageMeta);

  // 3. Sort groups by relevance
  const sortedGroups = sortMessageGroups(groups);

  // 4. Limit by message count, then flatten grouped hits.
  const limitedGroups = sortedGroups.slice(0, input.limit);
  const resultHits: SearchExecutionResult["hits"] = [];

  for (const group of limitedGroups) {
    const sortedGroupHits = [...group.hits].sort(compareRawHitsByPriority);

    for (const hit of sortedGroupHits) {
      const snippets = generateSnippets(
        hit.content,
        input.query,
        input.literal,
        snippetLength,
        maxSnippetsPerMessage,
        fulltextQueryTerms,
      );

      resultHits.push({
        documentId: hit.documentId,
        messageId: hit.messageId,
        type: hit.type,
        toolName: hit.toolName,
        snippets,
      });
    }
  }

  return {
    // totalHits is full matched hit count before message limiting.
    totalHits: searchResult.totalHits,
    hits: resultHits,
  };
}
