# Privacy policy

smasnug ai is a Slack bot run by Ingo Wolf (@inw) as a personal project. This policy explains what it collects, why, who it shares it with, and how long it keeps it. By clicking **I agree**, you agree to this policy.

## What the bot collects

- **Messages in conversations it's part of.** When you DM the bot or mention it, it stores the messages in that thread (text, files, link previews and edits) so it can follow the conversation. This includes messages from other people in the thread, even ones who haven't agreed to this policy, because the bot needs the whole thread to answer properly.
- **Things it looks up for you.** When you ask, it may read public channels and threads, search public Slack messages, open web pages and files, and run web searches. Messages starting with `##` are always ignored.
- **Memory about you.** It remembers short facts you share about yourself (your projects, preferences, role, time zone and similar) to personalise answers. It never stores sensitive facts on purpose. You can see and delete every fact in the bot's **App Home**, or say "forget …" in a conversation. A daily cleanup removes facts that only describe one request and merges duplicates; copies of what it removed are kept for about 30 days in case it got something wrong, and "forget everything" deletes those too.
- **Your earlier conversations with the bot.** When you refer back to something, it can search its stored copies of conversations you had with it (about the last 30 days). A DM or private conversation only shows up in that same conversation, or, for private channels you're still a member of, in your DM with the bot; never in a public channel.
- **Public directory data.** To find people and channels, it keeps a copy of public Slack profile fields (names, handle, title, pronouns, status, time zone) and public channel details (name, topic, purpose). It does not store emails, phone numbers or avatars.
- **Records of how it answered.** For each answer, the steps it took: the conversation context it was given, its working notes, the tools it used and what they returned, and how long and how much it cost. These exist to find mistakes and make the bot better.
- **Usage and moderation records.** Rate-limit counters, model usage, messages it sends on your behalf (with who asked), and reports.

## How it's used

Only to run the bot: answer you, do the tasks you ask for, keep it safe (rate limits, reports, suspensions), fix problems and improve how it answers. To improve it, Ingo reviews past conversations and their records, including DMs with the bot (with the help of AI tools such as Claude), to find where the bot went wrong or wasted effort, and changes its instructions. Conversation content is never copied into the bot's code or instructions, and never published. Your data is never sold, and never used for advertising.

## Who it's shared with

Answering means sending parts of the conversation to these services:

- **AI model providers.** [Hack Club AI](https://ai.hackclub.com) (which relays to [OpenRouter](https://openrouter.ai) and model providers), the [Anthropic API](https://www.anthropic.com), and OpenRouter directly as a fallback. Reviews of past conversations use [Anthropic](https://www.anthropic.com)'s Claude.
- **Search.** [Exa](https://exa.ai) (through Hack Club's proxy or directly) and Anthropic's web search.
- **Code sandboxes**, only if you ask for code to run: files and code run on [Modal](https://modal.com) in the US. Live previews are published on Cloudflare, and only after you accept Cloudflare's own terms.
- **Slack**, where everything the bot posts lives.

These services handle the data under their own privacy policies.

## How long it's kept

- Conversations, files you uploaded, and the bot's working data: deleted about **30 days** after the conversation goes quiet, and right away when you delete the message in Slack.
- Records of how it answered: deleted **30 days** after the answer. Deleting a message in Slack also deletes the records from that channel that may contain it, right away. A copy that ended up in a record somewhere else (for example in search results the bot read for someone in another channel) is deleted after the 30 days.
- Copies made for a review (including the review tools' own session logs) are deleted once the review is done.
- Memory facts: until you delete them, or after about **6 months** without being used.
- Directory data: kept up to date from Slack and removed when the profile or channel is removed.
- Messages sent on your behalf and reports: kept so reports stay accurate.

## Your choices

- See and delete what the bot remembers about you in its App Home.
- Delete your messages in Slack to remove them from the bot.
- **Withdraw your consent and delete your data** with the button in the bot's App Home. The bot stops answering you until you agree again, and right away deletes what it remembers about you, the messages and files of yours it has stored, its stored copy of your DMs with it, your reminders and watches, conversation summaries that include your messages, and the records of how it answered in those conversations. Copies that ended up elsewhere (for example in records of answers in other channels) are deleted within 30 days. Messages it sent on your behalf and reports are kept so reports stay accurate, your public directory entry follows your Slack profile, and nothing in Slack itself is touched. After withdrawing, messages you write in conversations the bot is part of are stored as context again, like anyone else's.
- Stop using the bot at any time, or ask Ingo to delete your data.

## Changes to this policy

This policy may be updated at any time. When it changes, the bot tells you the next time you use it, with a link to the new version. Continuing to use the bot after that means you accept the updated policy; if you don't, withdraw your consent in the bot's App Home (see "Your choices" above).

## Contact

Questions or deletion requests: message Ingo Wolf (@inw) in Slack.
