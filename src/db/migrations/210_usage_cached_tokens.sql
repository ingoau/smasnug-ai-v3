-- Input tokens served from the provider's prompt cache (OpenRouter usage.prompt_tokens_details.cached_tokens), so the
-- effect of the cache-friendly prompt order can be measured. Null when the provider didn't report it.
alter table usage add column cached_input_tokens int;
