# @deepseek-ai/dsh-system1-memory

Context selection and working memory for System 1 (Jev-only).

## What it provides

- **WorkingMemory**: per-task short-term storage with entry and character limits (drops oldest when full).
- **ContextSelector**: relevance-scored selection (recency + kind boost) with character budgeting.

## Known Limitations and Deferred Work

- Long-term (persistent) memory is out of scope; the host provides historical context via observations.
- Relevance is currently recency-based; semantic similarity is future work.
