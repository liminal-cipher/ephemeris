# Ephemeris

> A local-first note workspace that keeps every page in the browser and never talks to a centralized server.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-build-646CFF?logo=vite&logoColor=white)
![Yjs](https://img.shields.io/badge/Yjs-CRDT-FF9900)

## Motivation

I wanted a Notion I owned. Not a cheaper Notion or a faster one, but one where the notes sit on my machine and keep working when a company changes its pricing, its terms, or its mind about staying in business. The long-term idea was to put a model on top of my own notes rather than hand them to someone else's.

Ephemeris is the first cut at the substrate that would need: a workspace where pages, covers, and icons live in the browser's own database, with no account and no centralized database in the write path.

## What It Does

- **Hierarchical Document Model:** Organize notes with infinitely nested sub-pages, drag-and-drop re-parenting, collapsible tree toggles, and interactive breadcrumbs.
- **Collaborative Editing:** Edit notes in real-time with peers over WebRTC, without relying on a central backend.
- **Unified Details Panel:** Access sub-pages and backlinks via a dockable panel (bottom or right sidebar) to maintain context without cluttering the editor.
- **Graph View:** Visualize connections between pages linked via `[[wiki-link]]` syntax on an interactive 2D physics graph.
- **Rich Text Editing:** Write using Tiptap's markdown-style input rules and keyboard shortcuts, complete with mathematical formulas (KaTeX), code blocks, and double-click whitespace trimming.
- **Customization:** Assign pages an icon (from a full 1,484 Unicode catalog, uploaded images, or remote URLs) and a cover image, stored inline.
- **Offline & Portable:** Persist every change automatically using CRDTs (`y-indexeddb`) and Dexie fallback snapshots. Export the entire workspace to JSON for true data portability.

There is no sign-up, no server, and no network request required to write. Opening the app offline behaves exactly the same as opening it online.

## Architecture

```mermaid
graph TD
    A[React components] -->|activePageId| B(Zustand store)
    A -->|keystrokes| C(Tiptap / Yjs)
    C <-->|Sync| E(y-webrtc / P2P)
    C -->|Persist CRDT| F(y-indexeddb)
    C -->|Snapshot text| D(Dexie.js over IndexedDB)
    D -->|useLiveQuery: reactive reads for Sidebar/Graph| A
```

We use a hybrid architecture: `Dexie.js` powers the fast, reactive sidebar metadata and graph view indexing, while `Yjs` handles the complex rich-text conflict resolution and peer-to-peer sync for the active page editor.

## Tech Decisions

| Component | Choice | Why this over alternatives |
| --- | --- | --- |
| Storage | Dexie.js over raw IndexedDB | The native IndexedDB API is event-based and verbose for even simple queries. Dexie gives promises, and `useLiveQuery` turns a table into a reactive source, which removes the need for a data-fetching layer |
| CRDT | Yjs over Automerge | Yjs has deeper, battle-tested integration with ProseMirror/Tiptap and an excellent ecosystem of modular persistence/sync providers (`y-webrtc`, `y-indexeddb`). |
| Sync | y-webrtc over WebSocket server | True local-first requires no backend. WebRTC enables peers to directly sync their CRDT states via signaling servers, maintaining privacy and zero infra cost. |
| Graph View | react-force-graph-2d over raw D3 | Provides an immediate, performant canvas-based physics simulation for note connections without manually fighting D3's DOM manipulation in React. |
| Editor | Tiptap over a textarea or a markdown parser | ProseMirror stores the document as structured JSON, not a string. Block-level features later depend on the content already being a tree |
| State | Zustand over Context or Redux | Exactly one value is global, the active page id. That is six lines in Zustand and a provider tree in the alternatives |
| Testing | Vitest + RTL over Jest | Native ESM and Vite integration makes configuration near-zero, and runs incredibly fast using worker threads. |

## Results & Limitations

- **Signaling Server Dependency.** While data sync is P2P, WebRTC requires signaling servers to establish the initial connection. We currently rely on public signaling servers which are not guaranteed for production uptime.
- **Database size constraints.** Storing base64 cover images inline keeps pages self-contained, but the performance impact on Dexie.js and Yjs at scale remains unmeasured.

## Getting Started

Requires Node.js 20 or later.

```bash
git clone https://github.com/liminal-cipher/ephemeris.git
cd ephemeris
npm install
npm run dev
```

There is nothing to configure. No environment variables, no API keys, no database to provision, because there is no backend. 
Tests can be run with `npm run test`.

## Roadmap

The shell of the app is complete with V3 refinements (Workspace CRDTs, unified panels, and Graph View). Future exploration will focus on maximizing the value of local-first notes:
- **Performance Optimization**: Implement virtualized rendering for the sidebar tree to support workspaces scaling past thousands of notes smoothly.
- **Enhanced Media Integration**: Support custom image URLs and Unsplash integrations for page covers alongside local file uploads.
- **Multi-page Bulk Operations**: Enable dragging and re-parenting multi-selected notes simultaneously in the sidebar tree.
- **Tiptap v3 Upgrade**: Transition to Tiptap 3.x ecosystem once its dependencies and collaboration APIs stabilize.
- **Asynchronous Sync (Relay Server)**: Implement a lightweight encrypted relay (e.g. `y-websocket`) to allow peers to sync changes even if they aren't online at the same time.

## Status

Active. Local development resumed. Last updated 2026-08-30.

## License

MIT. See [LICENSE](LICENSE).
