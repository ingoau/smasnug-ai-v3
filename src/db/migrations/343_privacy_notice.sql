-- How a user came to have a policy version on record (src/features/privacy.ts): 'agreed' (clicked "I agree") or
-- 'notice' (had agreed to an earlier version and was shown the "policy updated" notice).
alter table privacy_consent add column if not exists via text not null default 'agreed';
