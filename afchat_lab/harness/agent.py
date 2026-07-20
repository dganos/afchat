"""Candidate agent: a local Ollama model answering questions over the corpus.

The model is driven through Ollama's native /api/chat — exactly as Aristo drives it.
Its only way to see the documents is the filesystem MCP server
(`@modelcontextprotocol/server-filesystem`) that the harness launches pointed at the
corpus. The harness acts as the MCP host: it lists the server's tools, advertises a
read-only subset to the model as function tools, and executes each tool call the
model makes.

This mirrors real "QA over documents": the model must navigate and read files itself.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from mcp import ClientSession, StdioServerParameters


# The system prompt is owned by the agent package (packages/<agent>/system_prompt.md);
# it is loaded via harness.package.load_package() and passed in as `system_prompt`.


# ── Content search (grep) ──────────────────────────────────────────────────────
# The filesystem MCP server's `search_files` matches file/dir NAMES
# (a path glob), NOT file contents — so the candidates have no way to locate a
# fact without reading whole files (which then overflow the context). The harness
# is the MCP host, so it implements its own content search and dispatches it
# locally (never forwarded to the MCP server).
CONTENT_SEARCH_NAME = "search_content"
# The search_content tool CONTRACT (description + JSON schema) lives in the agent
# package; this module only IMPLEMENTS it (see _grep_corpus / _dispatch_tool).


# Strip bidi/zero-width marks (ZWSP/ZWNJ/ZWJ, LRM/RLM, embeddings, isolates, BOM)
# that models often emit at a Hebrew↔Latin boundary — they silently break a literal
# substring match (e.g. "length OR אורך" can attach an RLM to "אורך").
_MARKS_RE = re.compile("[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]")


def _strip_marks(s: str) -> str:
    return _MARKS_RE.sub("", s)


_BAD_PATH_HINT = (
    "Omit 'path' to search ALL documents, or pass exact filename(s) shown by "
    "list_directory."
)


def _scan_roots(base: Path, path) -> "list[Path] | str":
    """Resolve the path arg to the files/dirs to scan, sandboxed to base.

    `path` may be None/"" (whole corpus), a single string, or a LIST of paths
    (small models sometimes pass an array). Returns an error string if any path
    escapes the corpus, contains a glob, or doesn't exist — a silent empty scan
    would read exactly like "the fact is not in the documents" (observed: gemma
    passing path=['*'] and then refusing to answer).
    """
    if not path:
        return sorted(base.rglob("*"))
    paths = path if isinstance(path, (list, tuple)) else [path]
    roots: list[Path] = []
    seen: set[Path] = set()
    for p in paths:
        if not p:
            continue
        if any(ch in str(p) for ch in "*?"):
            return f"[tool error] path '{p}' is a glob, not a filename. {_BAD_PATH_HINT}"
        pp = Path(str(p))
        target = (pp if pp.is_absolute() else base / pp).resolve()
        try:
            target.relative_to(base)
        except ValueError:
            return f"[tool error] path not within the corpus: {p}"
        if not target.exists():
            return f"[tool error] path '{p}' does not match any document. {_BAD_PATH_HINT}"
        for f in ([target] if target.is_file() else sorted(target.rglob("*"))):
            if f not in seen:
                seen.add(f)
                roots.append(f)
    return roots


# A markdown heading line ("#"–"######" + space) — used for the block breadcrumb.
_HEADING_RE = re.compile(r"#{1,6}\s")


def _corpus_catalog(base: Path) -> str:
    """One catalog line per document: filename — title: first section headings.

    This is what list_directory returns to the model. A bare file listing forces
    the model to pick among 32 files by NAME alone (blind doc selection — the
    dominant failure mode); the catalog shows each document's `# ` title and its
    first 6 `## ` headings so selection becomes reading, not guessing. Capped
    per line (long/garbled headings exist) so 32 files stay well under the
    tool-result char cap. MUST mirror chat.js corpusCatalog exactly (SAME AGENT
    rule).
    """
    lines: list[str] = []
    for f in sorted(base.rglob("*")):
        if not f.is_file():
            continue
        rel = f.relative_to(base).as_posix()
        try:
            doc = f.read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception:  # noqa: BLE001
            lines.append(rel)
            continue
        title = ""
        secs: list[str] = []
        for l in doc:
            ls = l.lstrip()
            if not title and ls.startswith("# "):
                title = " ".join(ls[2:].split())
            elif ls.startswith("## "):
                secs.append(" ".join(ls[3:].split()))
        line = rel + (" — " + title[:80] if title else "")
        if secs:
            shown = "; ".join(secs[:6])
            if len(shown) > 180:
                shown = shown[:180] + "…"
            line += ": " + shown
            if len(secs) > 6:
                line += f" (+{len(secs) - 6} more)"
        lines.append(line)
    return "\n".join(lines)


def _block_indices(lines: list[str], i: int, cap: int = 40) -> list[int]:
    """The line indices of the structural block enclosing match line i.

    The unit of meaning around a fact is its whole STRUCTURE, not N lines: a value
    can sit in any row of a table whose header carried the matched keyword (or
    vice versa — a matched bottom row is meaningless without its header), and a
    statement can need its whole paragraph. So: if line i is part of a markdown
    table, the block is the entire contiguous table; otherwise it is the enclosing
    paragraph (contiguous non-blank lines). The nearest preceding heading (up to
    60 lines back) is prepended as a breadcrumb so the model knows which section
    the block belongs to. Blocks longer than cap are windowed around the match —
    for tables the 2 header lines are always kept.
    """
    if lines[i].lstrip().startswith("|"):
        s = i
        while s > 0 and lines[s - 1].lstrip().startswith("|"):
            s -= 1
        e = i
        while e + 1 < len(lines) and lines[e + 1].lstrip().startswith("|"):
            e += 1
        idx = list(range(s, e + 1))
        if len(idx) > cap:
            ws = max(s + 2, i - 3)
            idx = [s, s + 1] + list(range(ws, min(e, ws + cap - 3) + 1))
    else:
        s = i
        while s > 0 and lines[s - 1].strip():
            s -= 1
        e = i
        while e + 1 < len(lines) and lines[e + 1].strip():
            e += 1
        if e - s + 1 > cap:
            s = max(s, i - cap // 2)
            e = min(e, s + cap - 1)
        idx = list(range(s, e + 1))
    for j in range(idx[0] - 1, max(-1, idx[0] - 61), -1):
        if _HEADING_RE.match(lines[j].lstrip()):
            idx.insert(0, j)
            break
    return idx


def _rank_blocks(blocks: list[dict], terms: list[str], k1: float = 1.2, b: float = 0.25) -> list[dict]:
    """Reorder matched blocks by BM25 relevance to the query terms.

    The old ordering was match-count-per-FILE, then line order within a file — so a
    chatty file with many incidental hits outranked the file holding the one dense
    table row that answers the question, and within a scoped single-file search the
    answer block was emitted in line order (often after the block that fits the
    result budget). BM25 scores each BLOCK: a block wins by containing more of the
    query's DISTINCT terms and its RARER terms (idf), with only mild length
    normalization (b=0.25) so answer-rich tables aren't penalized for being long.

    Determinism (SAME AGENT rule): tf is the non-overlapping substring count on the
    block's mark-stripped, lowercased CONTENT (never the "file:line:" prefixes); the
    score loop iterates `terms` in order so float accumulation matches JS exactly;
    the sort key rounds the score with floor(x*1e6+0.5)/1e6 (identical in both
    languages, and coarse enough to erase any libm last-ULP difference), then breaks
    ties by distinct-term coverage, then original position. MUST mirror chat.js
    rankBlocks exactly.
    """
    n = len(blocks)
    lens: list[int] = []
    tfs: list[dict] = []
    for blk in blocks:
        raw = _strip_marks(blk["raw"].lower())
        toks = raw.split()
        lens.append(max(1, len(toks)))
        tf = {t: raw.count(t) for t in terms if raw.count(t)}
        tfs.append(tf)
    avg = sum(lens) / n
    df = {t: sum(1 for tf in tfs if t in tf) for t in terms}
    scores: list[float] = []
    for i in range(n):
        s = 0.0
        for t in terms:  # fixed order → identical float accumulation across runtimes
            c = tfs[i].get(t, 0)
            if not c:
                continue
            idf = math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5))
            s += idf * (c * (k1 + 1)) / (c + k1 * (1 - b + b * lens[i] / avg))
        scores.append(s)

    def key(i: int):
        s6 = math.floor(scores[i] * 1e6 + 0.5) / 1e6
        return (-s6, -len(tfs[i]), i)

    return [blocks[i] for i in sorted(range(n), key=key)]


def _grep_corpus(
    corpus_dir: str, pattern: str, path=None, context: "int | None" = None,
    max_matches: int = 40, line_cap: int = 300,
) -> str:
    """Case-insensitive substring search over the corpus' text files.

    Returns "rel/path:lineno: <line>" for each match (lines clipped to line_cap),
    capped at max_matches. With context=N, also returns the N lines AFTER each
    match (grep -A style) so a whole section can be pulled by searching for its
    heading. When the model OMITS context, each match is expanded to its whole
    enclosing STRUCTURE — the entire table or paragraph plus the nearest section
    heading (see _block_indices) — because facts often sit in table rows that
    don't repeat the matched header/label keyword; overlapping matches collapse
    into one block. An explicit context=0 is honored (compact listing, e.g. a
    "## " heading catalog). Forgiving of two common model mistakes: an "A OR B"
    pattern matches a line containing ANY alternative, and `path` may be a
    string or a list. Sandboxed to corpus_dir.

    Breadth × depth budget: a WIDE search (more than 3 files in scope) is a
    locator, not a reader — at most 3 blocks per file (with a "+N more" pointer),
    files ordered by match count instead of alphabetically (so a hit in the last
    file can't be shadowed by early files under the result cap), and explicit
    context clamped to 10. Deep reading requires narrowing with `path`.
    """
    if not pattern:
        return "[tool error] search_content needs a non-empty 'pattern'."
    smart = context is None
    context = 0 if smart else max(0, min(int(context or 0), 60))
    base = Path(corpus_dir).resolve()

    roots = _scan_roots(base, path)
    if isinstance(roots, str):
        return roots  # path escaped the corpus

    # `pattern` may be a single term, a list of terms, or (forgiving fallback) a
    # string with "A OR B". A line matches if it contains ANY term. Bidi/zero-width
    # marks are stripped so a Hebrew↔Latin boundary can't break the substring match.
    raw = pattern if isinstance(pattern, (list, tuple)) else re.split(r"\s+OR\s+", str(pattern))
    needles = [n for n in (_strip_marks(str(t).strip().lower()) for t in raw) if n]
    if not needles:
        return "[tool error] search_content needs a non-empty 'pattern'."

    def clip(s: str) -> str:
        s = s.strip()
        return s if len(s) <= line_cap else s[:line_cap] + "…"

    files = [f for f in roots if f.is_file()]
    wide = len(files) > 3
    # The "## " table-of-contents idiom is exempt from wide budgeting: heading
    # lines are one-liners, and a capped catalog defeats its whole purpose.
    toc = all(set(n) == {"#"} for n in needles)
    per_file_cap = 3 if (wide and not toc) else max_matches
    if wide and not toc:
        context = min(context, 10)
        # A wide result must FIT the tool-result cap as whole blocks: 12 blocks of
        # the best-matching files beat 40 blocks chopped mid-block at the char cap.
        max_matches = min(max_matches, 12)

    sep = "\n\n" if (smart or context) else "\n"

    def scan(active: list[str]) -> list[tuple[int, list[dict]]]:
        per_file: list[tuple[int, list[dict]]] = []  # (match_count, blocks) per file
        for f in files:
            try:
                lines = f.read_text(encoding="utf-8", errors="replace").splitlines()
            except Exception:  # noqa: BLE001
                continue
            rel = f.relative_to(base).as_posix()
            fblocks: list[dict] = []  # each: {"disp": shown text, "raw": content for scoring}
            extra = 0  # matching lines beyond this file's block budget
            last_end = -1  # last line already emitted for this file (smart mode dedupe)
            for i, line in enumerate(lines):  # 0-based
                low = _strip_marks(line.lower())
                if not any(n in low for n in active):
                    continue
                if smart and i <= last_end:
                    continue  # already inside the previous block
                if len(fblocks) >= per_file_cap:
                    extra += 1
                    continue
                if smart:
                    idx = _block_indices(lines, i)
                    last_end = idx[-1]
                else:
                    idx = list(range(i, min(len(lines), i + 1 + context)))
                fblocks.append({
                    "disp": "\n".join(f"{rel}:{j + 1}: {clip(lines[j])}" for j in idx),
                    "raw": "\n".join(lines[j] for j in idx),
                })
            if not fblocks:
                continue
            if extra:
                fblocks[-1]["disp"] += (
                    f'\n[+{extra} more matching lines in {rel} — search with path="{rel}" to see them]'
                )
            per_file.append((len(fblocks) + extra, fblocks))
        return per_file

    note = ""
    active = needles
    per_file = scan(needles)
    if not per_file and any(" " in n for n in needles):
        # A multi-word phrase almost never matches as a literal substring (models
        # search whole sentences); relax to individual words rather than return a
        # false "not in the documents".
        words = list(dict.fromkeys(w for n in needles for w in n.split() if len(w) >= 2))
        if words:
            per_file = scan(words)
            active = words
            note = ("[no lines matched the exact phrase; showing lines matching its "
                    "individual words instead]\n\n")
    if not per_file:
        shown = " / ".join(f'"{n}"' for n in needles)
        return f"No lines containing {shown} were found in the documents."
    # Order blocks by BM25 relevance to the query terms, but ONLY for a WIDE
    # (locator) search — there it replaces the crude match-count-per-file order
    # (a chatty file's incidental hits outranking the one dense answer block).
    # A SCOPED search means the model already narrowed to a file: its natural line
    # order preserves structural context (a table read top-to-bottom, thresholds
    # in sequence) that reranking would scramble — so scoped searches keep the old
    # order. The "## " table-of-contents idiom always keeps document order.
    if wide and not toc and sum(len(fb) for _, fb in per_file) > 1:
        blocks = _rank_blocks([b for _, fb in per_file for b in fb], active)
    else:
        per_file.sort(key=lambda t: -t[0])
        blocks = [b for _, fb in per_file for b in fb]
    # Emit whole blocks up to a LINE budget (fits the tool-result char cap), so a
    # too-broad search ends with an explicit "+N more" instead of a mid-block chop
    # that silently hides every later match.
    out: list[str] = []
    used = 0
    for b in blocks:
        disp = b["disp"]
        n_lines = disp.count("\n") + 1
        if out and (used + n_lines > 110 or len(out) >= max_matches):
            break
        out.append(disp)
        used += n_lines
    text = note + sep.join(out)
    if len(out) < len(blocks):
        text += (
            f"\n\n[showing {len(out)} of {len(blocks)} matches; refine the pattern "
            f"or narrow with 'path' to see the rest]"
        )
    return text


# ── Semantic retrieval (local embeddings) ─────────────────────────────────────
# Lexical substring search cannot bridge a cross-language wording gap: the answer
# may be written in Latin ("...ACCUMULATOR...2800 PSI") while the question asks in
# Hebrew ("מצבר"), so grep returns the wrong-but-lexically-matching block and the
# fact is never seen. A local embedding model (bge-m3 via Ollama — open, on-device)
# maps meaning to vectors, so the answer block ranks near the QUESTION regardless of
# language, with NO hand-built vocabulary. This complements grep: grep stays primary
# (exact for numbers/codes), embeddings rescue the term-mismatch cases as a labelled
# supplement. The semantic query is the QUESTION (short grep patterns embed too
# noisily to rank reliably).
# DEFAULTS ONLY — id/max_chars/top_k come from the agent package's `embed_model`
# block via configure_embeddings() (SAME AGENT as Aristo); these values apply only
# if a package omits the block. MUST mirror api/chat.js's EMBED_* constants.
_EMBED_MODEL = "bge-m3"
_EMBED_MAX_CHARS = 1600  # cap per input: bge-m3 has a token limit; a huge table 400s
_EMBED_BASE = "http://localhost:11434"
_SEM_TOPK = 3            # semantic passages to append
_SEM_MIN_COS = 0.45      # below this the match is too weak to be worth showing


def configure_embeddings(embed_cfg: "dict | None") -> None:
    """Set the semantic-retrieval knobs from the agent package's `embed_model` block.

    Called once per run by the harness so the lab uses the SAME embedding model and
    caps as Aristo. A package without the block keeps the built-in defaults above.
    """
    global _EMBED_MODEL, _EMBED_MAX_CHARS, _SEM_TOPK
    if not embed_cfg:
        return
    _EMBED_MODEL = embed_cfg.get("id", _EMBED_MODEL)
    _EMBED_MAX_CHARS = int(embed_cfg.get("max_input_chars", _EMBED_MAX_CHARS))
    _SEM_TOPK = int(embed_cfg.get("top_k", _SEM_TOPK))

# Ambient question for the CURRENT answer turn, set by answer_question_ollama. The
# model calls search_content with a short pattern; the semantic supplement instead
# ranks against this full question. Not a tool argument — the harness supplies it.
_CURRENT_QUESTION: str = ""

# Per-corpus block index: [{file, line, disp, raw, vec}], built once and cached to
# disk (keyed by corpus signature + model) so we embed the corpus a single time.
_BLOCK_INDEX: "dict[str, list[dict]]" = {}
_QV_CACHE: "dict[str, list[float]]" = {}  # question -> its embedding (per-question memo)


def _embed(texts: list[str]) -> "list[list[float]]":
    """Embed texts with the local bge-m3 model via Ollama /api/embed (batched)."""
    out: list[list[float]] = []
    capped = [(t[:_EMBED_MAX_CHARS] if len(t) > _EMBED_MAX_CHARS else t) or " " for t in texts]
    for k in range(0, len(capped), 32):
        batch = capped[k:k + 32]
        req = urllib.request.Request(
            _EMBED_BASE.rstrip("/") + "/api/embed",
            data=json.dumps({"model": _EMBED_MODEL, "input": batch}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=120) as r:
            out.extend(json.loads(r.read())["embeddings"])
    return out


def _chunk_doc(lines: list[str]) -> "list[tuple[int, str]]":
    """Segment a document into structural blocks: (1-based start line, raw text).

    Same structure notion as _block_indices but applied EXHAUSTIVELY (non-overlapping
    coverage, not around a match): each contiguous markdown table is a block; each
    contiguous non-blank paragraph is a block; the nearest preceding heading (<=60
    lines) is prepended as a breadcrumb so the block carries its section context.
    """
    blocks: list[tuple[int, str]] = []
    i, n = 0, len(lines)
    while i < n:
        if not lines[i].strip():
            i += 1
            continue
        s = i
        if lines[i].lstrip().startswith("|"):
            while i + 1 < n and lines[i + 1].lstrip().startswith("|"):
                i += 1
        else:
            while i + 1 < n and lines[i + 1].strip():
                i += 1
        e = i
        head = None
        for j in range(s - 1, max(-1, s - 61), -1):
            if _HEADING_RE.match(lines[j].lstrip()):
                head = lines[j]
                break
        raw = "\n".join(([head] if head else []) + lines[s:e + 1])
        blocks.append((s + 1, raw))
        i = e + 1
    return blocks


def _build_block_index(base: Path) -> list[dict]:
    """Chunk + embed the whole corpus once; cache vectors to disk by signature."""
    key = str(base)
    if key in _BLOCK_INDEX:
        return _BLOCK_INDEX[key]
    files = sorted(f for f in base.rglob("*") if f.is_file())
    raw_blocks: list[dict] = []
    for f in files:
        rel = f.relative_to(base).as_posix()
        try:
            lines = f.read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception:  # noqa: BLE001
            continue
        for ln, raw in _chunk_doc(lines):
            disp = "\n".join(f"{rel}:{ln + off}: {t}" for off, t in enumerate(raw.split("\n")))
            raw_blocks.append({"file": rel, "line": ln, "disp": disp, "raw": raw})
    sig = hashlib.sha1(
        (_EMBED_MODEL + "\x00" + "\x00".join(b["raw"] for b in raw_blocks)).encode("utf-8")
    ).hexdigest()
    # Cache OUTSIDE the corpus dir — a file under `base` would be picked up by every
    # corpus scan (catalog, grep, this very index) as a spurious 27 MB "document".
    cache = base.parent / f".embed_cache_{base.name}_{_EMBED_MODEL.replace(':', '_')}.json"
    vecs: "list[list[float]] | None" = None
    if cache.exists():
        try:
            cached = json.loads(cache.read_text())
            if cached.get("sig") == sig:
                vecs = cached["vecs"]
        except Exception:  # noqa: BLE001
            vecs = None
    if vecs is None:
        vecs = _embed([b["raw"] for b in raw_blocks])
        try:
            cache.write_text(json.dumps({"sig": sig, "vecs": vecs}))
        except Exception:  # noqa: BLE001
            pass
    for b, v in zip(raw_blocks, vecs):
        b["vec"] = v
    _BLOCK_INDEX[key] = raw_blocks
    return raw_blocks


def _cosine(a: list, b: list) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def _semantic_supplement(base: Path, question: str, scope_rels: "set[str] | None") -> str:
    """Top semantic passages for the question, as a labelled supplement (or "").

    Ranks the pre-embedded corpus blocks by cosine to the QUESTION, restricted to
    `scope_rels` when the search was path-scoped. Returns only passages above a
    similarity floor, so a question with no semantically-close block adds nothing.
    """
    if not question:
        return ""
    try:
        index = _build_block_index(base)
        qv = _QV_CACHE.get(question)
        if qv is None:
            qv = _embed([question])[0]  # cache: the model calls search_content repeatedly per question
            _QV_CACHE[question] = qv
    except Exception:  # noqa: BLE001
        return ""  # embeddings unavailable → silently fall back to lexical only
    cand = [b for b in index if scope_rels is None or b["file"] in scope_rels]
    # Round with floor(x*1e6+0.5)/1e6 (identical in JS) so the JS app ranks the same.
    scored = sorted(
        ((math.floor(_cosine(qv, b["vec"]) * 1e6 + 0.5) / 1e6, i, b) for i, b in enumerate(cand)),
        key=lambda t: (-t[0], t[1]),
    )
    picks = [(s, b) for s, i, b in scored[:_SEM_TOPK] if s >= _SEM_MIN_COS]
    if not picks:
        return ""
    body = "\n\n".join(b["disp"] for _, b in picks)
    return (
        "\n\n[Related passages by MEANING (semantic search on the question — the "
        "wording may differ from your search terms; verify the value before using):]\n\n"
        + body
    )


def load_fs_server_params(corpus_dir: str) -> StdioServerParameters:
    """Build StdioServerParameters for the filesystem MCP server.

    The server's allowed directory is the corpus, so the candidate is sandboxed
    to the test documents.
    """
    corpus_dir = str(Path(corpus_dir).resolve())
    return StdioServerParameters(
        command="npx", args=["-y", "@modelcontextprotocol/server-filesystem", corpus_dir]
    )


@dataclass
class AgentResult:
    answer: str = ""
    steps: int = 0
    tool_calls: list[dict] = field(default_factory=list)
    error: str | None = None
    finish: str = "answered"  # answered | max_steps | error


async def _dispatch_tool(
    session: ClientSession, name: str, args: dict, cap: int, corpus_dir: str | None = None,
) -> str:
    try:
        if name == CONTENT_SEARCH_NAME:
            # Harness-implemented content search — never forwarded to the MCP server.
            out = _grep_corpus(
                corpus_dir or ".", args.get("pattern", ""), args.get("path"), args.get("context")
            )
            # Append semantic passages for the ambient QUESTION — rescues cross-language
            # wording gaps grep can't bridge. Scope to the same path if the search was
            # path-scoped. Best-effort: any failure leaves the lexical result untouched.
            if corpus_dir and _CURRENT_QUESTION:
                try:
                    base = Path(corpus_dir).resolve()
                    roots = _scan_roots(base, args.get("path"))
                    scope = None
                    if not isinstance(roots, str) and args.get("path"):
                        scope = {f.relative_to(base).as_posix() for f in roots if f.is_file()}
                    out += _semantic_supplement(base, _CURRENT_QUESTION, scope)
                except Exception:  # noqa: BLE001
                    pass
        elif name == "list_directory" and corpus_dir:
            # Harness-implemented (never forwarded to the MCP server): returns the
            # corpus CATALOG — one line per file with title + main headings — so
            # document selection is reading, not name-guessing. Path normalization
            # kept from the old forwarding version: models pass ".", "./corpus_124",
            # or other guesses, and a model that never gets a listing concludes
            # "there are no documents" (observed). Any path that doesn't resolve
            # to a real directory under the corpus falls back to the corpus root —
            # mirroring Aristo.
            base = Path(corpus_dir).resolve()
            p = str(args.get("path") or "").strip()
            target = (Path(p) if Path(p).is_absolute() else base / p).resolve() if p else base
            try:
                target.relative_to(base)
            except ValueError:
                target = base
            if not target.is_dir():
                target = base
            out = _corpus_catalog(target)
        else:
            res = await session.call_tool(name, args)
            parts = []
            for block in res.content:
                text = getattr(block, "text", None)
                parts.append(text if text is not None else str(block))
            out = "\n".join(parts)
    except Exception as e:  # noqa: BLE001
        return f"[tool error] {e}"[:cap]
    if len(out) > cap:
        # Make truncation VISIBLE: a silent cut leaves the model unable to tell the
        # answer span was dropped, so it wrongly concludes the info is missing.
        full = len(out)
        out = out[:cap] + (
            f"\n\n[TRUNCATED: showed the first {cap} of {full} characters; the rest "
            f"was NOT shown. The answer may be in the unshown part — call "
            f"search_content with a keyword from the question (a number, unit, or "
            f"term) to locate the passage, then read around it.]"
        )
    return out


# Some local models (notably gemma) sometimes emit a tool call as plain TEXT in
# their chat-template format instead of through the API's structured tool_calls
# channel — most often on a turn where no tools were advertised, but it can leak
# mid-loop too. Such text is NOT an answer and must never be shown or scored as
# one; we detect it and convert it back into a real tool call.
#
# Observed gemma form:
#   <|tool_call>call:search_files{path:<|"|>foo.md<|"|>,keyword:<|"|>length<|"|>}<tool_call|>
# Also handled: the generic <tool_call>{ ...json... }</tool_call> form.
_GEMMA_CALL_RE = re.compile(
    r"<\|?tool_call\|?>\s*call:(?P<name>\w+)\s*\{(?P<body>.*?)\}\s*<\/?\|?tool_call\|?>",
    re.DOTALL,
)
_JSON_CALL_RE = re.compile(r"<tool_call>\s*(?P<json>\{.*?\})\s*</tool_call>", re.DOTALL)
_ARG_PAIR_RE = re.compile(r'(\w+)\s*:\s*"([^"]*)"')


def _parse_gemma_args(body: str) -> dict:
    # gemma wraps string values in a literal <|"|> quote token; normalise to ".
    body = body.replace('<|"|>', '"')
    return {k: v for k, v in _ARG_PAIR_RE.findall(body)}


def parse_text_tool_calls(content: str) -> tuple[str, list[dict]]:
    """Extract tool calls a model emitted as plain text (chat-template leakage).

    Returns (cleaned_content, calls). Each call matches the streamed tool-call slot
    shape ({"id","name","args"} with args as a JSON string), so it flows through the
    normal execution path. The tool-call spans are removed from the content so a
    leaked call can never be returned as the model's answer text.
    """
    if not content or "tool_call" not in content:
        return content, []
    calls: list[dict] = []
    cleaned = content

    def add(name: str, args: dict, raw: str) -> None:
        nonlocal cleaned
        calls.append({"id": f"call_text_{len(calls)}", "name": name,
                      "args": json.dumps(args, ensure_ascii=False)})
        cleaned = cleaned.replace(raw, "")

    for m in _GEMMA_CALL_RE.finditer(content):
        add(m.group("name"), _parse_gemma_args(m.group("body")), m.group(0))
    for m in _JSON_CALL_RE.finditer(content):
        try:
            obj = json.loads(m.group("json"))
        except json.JSONDecodeError:
            continue
        name = obj.get("name") or obj.get("tool") or ""
        args = obj.get("arguments") or obj.get("args") or {
            k: v for k, v in obj.items() if k not in ("name", "tool")
        }
        if name:
            add(name, args if isinstance(args, dict) else {}, m.group(0))
    return cleaned.strip(), calls


# ── Reference candidate: Claude via the Agent SDK ──────────────────────────────
# Lets a hosted model (Claude) be benchmarked as a candidate alongside the local
# Ollama models — same question set, same judge, same logs. Claude navigates
# the corpus with its own read-only tools (Read/Glob/Grep), mirroring the local
# candidates' list/read/search tools.

CLAUDE_CANDIDATE_PROMPT = (
    "You answer questions using ONLY the documents in the current directory. Use your "
    "file tools to list, read, and search the documents, find the specific fact, and give "
    "a short, direct final answer. Ground every answer in the documents; do not invent "
    "facts. Answer in the SAME language as the question. Keep the final answer concise "
    "(one or two sentences with the exact numbers/terms)."
)


async def answer_question_claude(
    corpus_dir: str, question: str, cfg: dict, on_event=None, model: str = "claude-sonnet-4-6",
) -> AgentResult:
    """Answer one question by driving Claude agentically over the corpus (read-only)."""
    def emit(*a):
        if on_event:
            on_event(*a)

    try:
        from claude_agent_sdk import query, ClaudeAgentOptions
    except Exception as e:  # noqa: BLE001
        return AgentResult(error=f"claude-agent-sdk unavailable: {e}", finish="error")

    corpus_dir = str(Path(corpus_dir).resolve())
    max_steps = int(cfg.get("max_steps", 8))
    options = ClaudeAgentOptions(
        system_prompt=CLAUDE_CANDIDATE_PROMPT,
        allowed_tools=["Read", "Glob", "Grep"],
        cwd=corpus_dir,
        permission_mode="bypassPermissions",
        max_turns=max_steps,
        model=model,
    )

    for attempt in range(3):  # retry transient Agent SDK errors (rate limits)
        result = AgentResult()
        texts: list[str] = []
        emit("speak_start", 0)
        try:
            async for message in query(prompt=question, options=options):
                for block in getattr(message, "content", []) or []:
                    t = getattr(block, "text", None)
                    if t:
                        texts.append(t)
                        emit("token", t)
                    if block.__class__.__name__ == "ToolUseBlock" or getattr(block, "type", None) == "tool_use":
                        name = getattr(block, "name", "tool")
                        inp = getattr(block, "input", {}) or {}
                        result.tool_calls.append({"name": name, "args": inp, "chars": 0})
                        result.steps += 1
                        emit("tool", name, inp)
            emit("speak_end")
            result.answer = next((t.strip() for t in reversed(texts) if t.strip()), "")
            result.steps = max(result.steps, 1)
            result.finish = "answered"
            return result
        except Exception as e:  # noqa: BLE001
            emit("speak_end")
            result.error = f"claude candidate error: {e}"
            result.finish = "error"
            if attempt < 2:
                await asyncio.sleep(8 * (attempt + 1))
                continue
            return result


# DEFAULTS ONLY — the live values come from the agent package's runtime.recovery
# policy (the single source of truth shared with Aristo). These fallbacks preserve
# behaviour if a package predates the recovery block.
#
# A "not found in the documents" style answer, in the lab's two languages. Used by
# the pointer nudge — heuristic on purpose, only ever triggers ONE extra clarifying
# turn, never changes scoring.
_REFUSAL_MARKS = (
    "לא נמצא", "לא נמצאו", "אינו מופיע", "אינם מופיעים", "אין מידע", "אינו נמצא",
    "not found", "no information", "not available", "does not appear", "couldn't find",
)
# Markers _grep_corpus puts on results it had to cut — an unfollowed pointer means
# the model concluded "missing" without looking where the tool told it to look.
_POINTER_MARKS = ("more matching lines in", "refine the pattern or narrow with 'path'")


def _is_refusal(text: str, markers=_REFUSAL_MARKS) -> bool:
    low = (text or "").lower()
    return any(m in low for m in markers)


# ── Candidate: local model via Ollama's native /api/chat ───────────────────────
# Talks to Ollama EXACTLY as Aristo does: the native /api/chat endpoint (NOT the
# OpenAI /v1 shim, which doesn't route custom gemma renderers and ignores num_ctx),
# tools as OpenAI-style function specs, the context window via options.num_ctx.
# Non-streaming (like Aristo's simulateStreaming) so structured tool_calls come
# back reliably. The filesystem tools come from the MCP server.

def ollama_capabilities(base_url: str, model: str) -> list[str]:
    """The model's declared capabilities per /api/show (e.g. ["tools", "thinking"]).

    Used for ad-hoc models (not in the config): thinking-capable ones get the lab's
    uniform think=false policy, tool-less ones get a loud warning. Returns [] if the
    lookup fails — callers must treat that as "unknown", not "no capabilities".
    """
    try:
        req = urllib.request.Request(
            base_url.rstrip("/") + "/api/show",
            data=json.dumps({"model": model}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read()).get("capabilities", []) or []
    except Exception:  # noqa: BLE001
        return []


def _ollama_chat(base_url: str, model: str, messages: list, tools, num_ctx, temperature: float, timeout: int, think: "bool | None" = None, num_predict: int = 0) -> dict:
    payload = {"model": model, "messages": messages, "stream": False,
               "options": {"temperature": temperature}}
    if num_ctx:
        payload["options"]["num_ctx"] = int(num_ctx)
    if num_predict:
        # Bound generation so a runaway/repetition loop can't burn a whole
        # request_timeout_s. Tool-call turns are ~60 tokens; answers are short.
        payload["options"]["num_predict"] = int(num_predict)
    if tools:
        payload["tools"] = tools
    # Thinking models (gemma-4, qwen3) sometimes emit their thinking block and then
    # STOP without producing the tool call or any content — the turn is lost and the
    # question scores 0. think=false (per-model config knob) suppresses the thinking
    # channel. Only send it when explicitly set: non-thinking models reject the field.
    if think is not None:
        payload["think"] = bool(think)
    req = urllib.request.Request(
        base_url.rstrip("/") + "/api/chat",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def _ollama_transient(e: Exception) -> bool:
    """Transient Ollama failures worth retrying: timeouts, connection drops, 5xx.

    NOT transient: HTTP 4xx (bad request / unsupported field / model not found).
    A retry after a timeout is cheap — Ollama keeps the processed prompt prefix
    cached, so the second attempt resumes mostly warm instead of re-prefilling.
    """
    code = getattr(e, "code", None)  # urllib.error.HTTPError
    if code is not None:
        return int(code) >= 500
    msg = str(e).lower()
    return any(m in msg for m in (
        "timed out", "timeout", "connection", "reset", "refused", "temporarily",
    ))


async def _ollama_chat_retry(emit, *args, attempts: int = 3, **kwargs) -> dict:
    """_ollama_chat with retry on transient errors."""
    last: Exception | None = None
    for k in range(attempts):
        try:
            return await asyncio.to_thread(_ollama_chat, *args, **kwargs)
        except Exception as e:  # noqa: BLE001
            last = e
            if not _ollama_transient(e) or k == attempts - 1:
                raise
            emit("retry", str(e)[:120], k + 1)
            await asyncio.sleep(5 * (k + 1))
    raise last  # unreachable; keeps type-checkers happy


async def answer_question_ollama(
    session: ClientSession,
    oai_tools: list[dict],
    base_url: str,
    model: str,
    corpus_dir: str,
    question: str,
    cfg: dict,
    on_event=None,
    system_prompt: str | None = None,
    num_ctx: int | None = None,
    think: "bool | None" = None,
) -> AgentResult:
    """Run the tool-using loop for one question against Ollama's native /api/chat."""
    def emit(*a):
        if on_event:
            on_event(*a)

    # Make the full question available to the semantic supplement in search_content
    # (the model only passes short patterns; the question ranks embeddings reliably).
    global _CURRENT_QUESTION
    _CURRENT_QUESTION = question

    corpus_dir = str(Path(corpus_dir).resolve())
    cap = int(cfg.get("max_tool_result_chars", 6000))
    max_steps = int(cfg.get("max_steps", 8))
    temperature = float(cfg.get("temperature", 0))
    timeout = int(cfg.get("request_timeout_s", 180))
    num_predict = int(cfg.get("num_predict", 0))
    # Loop error-recovery policy from the shared package (SAME AGENT as Aristo).
    # Defaults preserve behaviour for a package without a recovery block.
    rec = cfg.get("recovery") or {}
    rec_transient = int(rec.get("transient_retries", 3))
    rec_empty = rec.get("empty_turn_nudge",
                        "Your last reply was empty. Based only on the documents you have read, "
                        "give your final answer now.")
    rec_final = rec.get("max_steps_final",
                        "Based only on the documents you have read, give your final answer now.")
    rec_pointer = rec.get("refusal_pointer_nudge",
                          "Your last search result was CUT and said more matching lines exist "
                          "(see its final bracketed note, which names the file). Search that file "
                          "with path=<that file> and a refined pattern, then answer from what you find.")
    rec_refusal_markers = rec.get("refusal_markers", _REFUSAL_MARKS)
    rec_pointer_markers = rec.get("pointer_markers", _POINTER_MARKS)

    if not system_prompt:
        raise ValueError("system_prompt is required (provided by the agent package)")
    tools = list(oai_tools)

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"Allowed corpus directory: {corpus_dir}\n\nQuestion: {question}"},
    ]
    result = AgentResult()

    async def chat(use_tools: bool) -> dict:
        return await _ollama_chat_retry(
            emit, base_url, model, messages,
            tools if use_tools else None, num_ctx, temperature, timeout, think, num_predict,
            attempts=rec_transient,
        )

    unfollowed_pointer = False  # last search result was cut and carried a "+N more" pointer

    async def run_calls(tool_calls: list) -> None:
        # Record the assistant turn (Ollama format) then execute each tool call.
        nonlocal unfollowed_pointer
        messages.append({"role": "assistant", "content": "", "tool_calls": tool_calls})
        for tc in tool_calls:
            fn = tc.get("function", {}) or {}
            name = fn.get("name", "")
            args = fn.get("arguments", {})
            if isinstance(args, str):
                try:
                    args = json.loads(args or "{}")
                except json.JSONDecodeError:
                    args = {}
            emit("tool", name, args)
            output = await _dispatch_tool(session, name, args, cap, corpus_dir)
            result.tool_calls.append({"name": name, "args": args, "chars": len(output)})
            emit("tool_result", name, len(output))
            messages.append({"role": "tool", "content": output, "tool_name": name})
            unfollowed_pointer = any(m in output for m in rec_pointer_markers)

    empty_retry = False
    pointer_retry = False
    for step in range(max_steps):
        result.steps = step + 1
        emit("speak_start", step)
        try:
            resp = await chat(True)
        except Exception as e:  # noqa: BLE001
            result.error = f"ollama /api/chat error: {e}"
            result.finish = "error"
            return result
        msg = resp.get("message", {}) or {}
        content = (msg.get("content") or "").strip()
        tool_calls = msg.get("tool_calls") or []
        # gemma may still leak a tool call as text — recover it as a real call.
        if not tool_calls and content:
            content, leaked = parse_text_tool_calls(content)
            tool_calls = [{"function": {"name": c["name"], "arguments": json.loads(c["args"] or "{}")}}
                          for c in leaked]
        if content:
            emit("token", content)
        emit("speak_end")

        if not tool_calls:
            if not content and not empty_retry:
                # An empty turn is not an answer (e.g. a stripped template leak or a
                # dropped generation) — nudge once instead of scoring "" as a 0.
                empty_retry = True
                messages.append({"role": "user", "content": rec_empty})
                continue
            if content and _is_refusal(content, rec_refusal_markers) and unfollowed_pointer and not pointer_retry:
                # The model says "not found" while its LAST search result explicitly
                # said more matches exist in a named file. Push it to look there
                # once before accepting the refusal.
                pointer_retry = True
                messages.append({"role": "user", "content": rec_pointer})
                continue
            result.answer = content
            result.finish = "answered"
            return result
        await run_calls(tool_calls)

    # Out of steps: ask for a final answer with no tools.
    messages.append({"role": "user", "content": rec_final})
    emit("speak_start", "final")
    try:
        resp = await chat(False)
    except Exception as e:  # noqa: BLE001
        result.error = f"final answer error: {e}"
        result.finish = "error"
        return result
    content = ((resp.get("message", {}) or {}).get("content") or "").strip()
    if content:
        emit("token", content)
    emit("speak_end")
    result.answer = content
    result.finish = "max_steps"
    return result
