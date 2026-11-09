# Privacy

Hobbots runs on your computer. Your hobs, threads, Tasks, memory and settings are kept in the hub's database and data folder there. This page says what leaves your computer when your hobs work, and where it goes.

## Your hobs' runtimes

A hob thinks with Claude Code or Codex, signed in with your own account. Each turn sends the runtime's model what the hob is given and what it reads: your message, its instructions and briefing, and the files, command output, pages and search results it works with. That goes to Anthropic for Claude Code and to OpenAI for Codex, under your account's terms with them. Hobbots adds no account or server of its own in between.

## Web search

A hob searches with its runtime's own search, never with a provider of Hobbots' own.

- **Claude Code** runs the search on Anthropic's servers, which search with their partners. The query goes to Anthropic.
- **Codex** is held to cached search: OpenAI answers from its own index and never opens a page for the hob. The query goes to OpenAI.

Search the web can be set to Never for a hob in its Permissions, and then its runtime is offered no search.

## Pages a hob reads

`web_fetch` reads a page from the hub, on your own network and from your own address, so the site sees that address.

- It sends a plain `GET` with the user agent `Hobbots/<version> (+https://hobbots.ai)`. It sends no cookie, password, sign-in or body, and nothing else of yours.
- It honors robots.txt rules that name Hobbots. It does not read a site you blocked in Settings › Web.
- It never reaches `localhost`, link-local or cloud metadata addresses. A page on your local network asks you first.
- A page you have not allowed asks you first under Careful. An address a hob wrote itself, which could carry your data in it, asks under every preset.

Use the web can be set to Never for a hob in its Permissions, and then it is offered no `web_fetch`.

## After a hob reads the web

A page can try to make a hob send your data somewhere. Once a chat or a Task searched or read a page, anything that could send data out asks you first until that session ends, even where a saved rule would answer: an address the hob wrote, a command reaching a new host, a Charm write such as a GitHub comment, a push and a memory share.

## What Hobbots keeps of the web

- Each search (its query and its results' titles and addresses) and each page read (its address, size and status) is recorded in the hub's database, for Usage and the chat's sources. Backups and exports hold them.
- Pages read are cached in the hub's memory for 15 minutes. The cache is in no backup, export or Diagnostics report, and Settings › Web's Clear now or restarting the hub empties it.
- Diagnostics hold the web limits, how many sites are blocked and how many searches and pages all hobs made in the last day. They never hold a query, an address or a site.

## Charms

A Charm you connect, such as GitHub, sends what a hob reads or writes through it to that service, under the account you connected and the permissions you gave the hob.
