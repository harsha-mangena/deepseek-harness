# @deepseek-ai/dsh-system1-memory

Context selection and working memory for System 1 (Jev-only).

## What it provides

- **WorkingMemory**: per-task short-term storage with entry and character limits. Oldest entries are evicted first; a single entry larger than the character budget is truncated to the budget with a truncation marker, so `retrieve` never returns more than `maxCharsPerTask` characters.
- **ContextSelector**: relevance-scored selection (recency + kind boost) with character budgeting. The returned string never exceeds `maxChars` characters, separators included; an entry that does not fit whole is truncated to the remaining budget with a marker instead of being silently dropped.
- Character budgets throughout count Unicode characters (not UTF-16 code units or bytes) and truncation never splits a surrogate pair.

## Known Limitations and Deferred Work

- Long-term (persistent) memory is out of scope; the host provides historical context via observations.
- Relevance is currently recency-based; semantic similarity is future work.
