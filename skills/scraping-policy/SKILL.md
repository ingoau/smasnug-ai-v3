---
name: scraping-policy
description: Hack Club's Slack scraping use policy and how to apply it. Load before collecting or exporting the exact content of Slack messages (all messages from a channel, thread or person into a file, CSV, canvas, dataset or list; a transcript or archive; training data), or anything similar.
roles: [front, child]
---

# Scraping messages on the Hack Club Slack

The Fire Department (FD) published a scraping use policy for the Slack (in effect from June 15 2026; full text below,
source: https://news.hackclub.com/news/scraping-use-policy/). Follow it whenever a request means collecting the exact
content of other people's messages so it can be kept or reused.

## What counts

- Collecting message content into something that lasts (a file, CSV, canvas, dataset, list, transcript or archive, or
  a long verbatim dump in a reply someone can save) is scraping. So is gathering every message by one person.
- Not scraping: reading a thread or channel to answer a question, summarising it, quoting a message or two as part of
  an answer, linking to messages (permalinks). Do those as usual.
- Message metadata without content or sender (counts, timestamps, reactions) is fine for messages sent on or after
  June 15 2026.

## Deciding

Do it when every message you'd include fits one of these:
- the speaker's own messages;
- an informational channel designated by the FD/HQ (#announcements, official Hack Club program bulletin channels,
  #help and dedicated help channels such as #stardance-help or #identity-help);
- a channel the speaker owns or manages, with notice of the scraping publicly posted there (pinned message or channel
  topic), or another user's channel where members were notified and the owner consented;
- authors who clearly consented in writing (a Slack message or form you can point to).

Messages sent before June 15 2026 need explicit consent from every author (informational channels excepted).

When it doesn't fit (or you can't tell), don't make the export. Say briefly why, in one plain line, link the policy, and
offer what is allowed: a summary, metadata stats, the speaker's own messages, permalinks, or the export once the authors
consent (or the channel has notice). Don't lecture, and don't refuse the parts that are fine.

Also:
- Never publish scraped content on the open web (a public page, live preview or gist). Shared output stays inside the
  Slack or behind Hack Club auth (HCA).
- Training AI models on messages needs explicit consent from the authors. Sending message content to a third-party
  service needs authors informed and given an easy opt-out first.
- Never use collected messages to harass, impersonate, sexualise, profile or target someone (that's misuse anyway).
- Uses beyond analysis, search, summarising or similar: point the speaker to the FD via Shroud to confirm.

## The policy (verbatim)

> **Scraping Use Policy for the Slack**, by @lou, June 14, 2026
>
> The Fire Department regularly gets questions from people who want to scrape messages on the Slack, but don't know
> what's allowed.
>
> After months of discussion with the community, we have a draft Scraping policy. It's not perfect, but it's a starting
> point, open to discussion and improvement. This policy takes effect on Monday, June 15.

### Rules for Scraping on the Hack Club Slack

"Scraping" means collecting and storing message content for later retrieval, analysis, indexing, training or reuse.
Processing live message events without storing message contents is not considered scraping.

If a user withdraws consent for messages that were collected through explicit consent, reasonable efforts should be made
to remove those messages from future datasets, indexes and storage.

Any use of scraped messages remains subject to the Code of Conduct.

Projects that scrape messages should clearly disclose what data is being collected and how it is being used.

### What is allowed

1. Scraping your own messages.
2. Scraping message metadata that does not include message contents or sender (eg: reactions, timestamps or message
   count) for any messages sent on or after June 15 2026.
3. Scraping the contents and identity of other users' messages with their clear consent. Consent should be given
   through a written and reasonably verifiable record (eg: a Slack message or form submission)
4. Scraping messages sent in a channel that you own and manage after notice has been publicly posted. Notice should be
   clearly visible through an anchored message or channel topic.
5. Scraping messages in channels owned by another user when both:
   - Notice has been provided to channel members
   - The channel owner has consented to it
6. Scraping messages in informational channels specifically designated by the FD and/or HQ for announcements, event
   support, documentation or other public information purposes. Right now, these channels are:
   - #announcements
   - All official bulletin channels for Hack Club programs
   - #help and dedicated help channels, like #stardance-help and #identity-help
7. Processing messages that meet the above criteria for analysis, indexing, search, retrieval, summarisation, analytics
   or other similar purposes. If your use purpose is not mentioned here, reach out directly to the FD via Shroud to
   confirm.
8. Sending message content to any third party service for processing is permitted only when:
   - The messages meet the above criteria
   - The message authors have been clearly informed that message contents may be shared with external service
     providers and have the opportunity to easily opt out prior.
9. Training AI models on messages only when:
   - The messages meet the above criteria
   - The message authors have explicitly consented to their messages being used for model training.

### What is not allowed

1. Scraping messages in channels you do not own or manage without the required consent (see What is allowed - 5)
2. Scraping messages in channels you own or manage without first providing clear notice (see What is allowed - 4)
3. Scraping messages sent before June 15 2026 without explicit consent from every message author. The only exception is
   informational channels.
4. Making scraped message content publicly accessible on the open web. If scraped messages are made visible to people
   other than the person who collected the messages, access must be restricted to authenticated Hack Clubbers (such as
   via HCA) or another agreed on and approved audience.
5. Training AI models on messages without explicit consent from the message authors.
6. Using scraped messages to harass, impersonate, sexualise, profile or otherwise target others in ways that would
   violate the Code of Conduct.
