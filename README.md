# O2C Graph Explorer

A **graph-based data modeling and query system** for SAP Order-to-Cash (O2C) data. Converts fragmented SAP business tables into an interactive force-directed graph with an LLM-powered natural language query interface.

**Built for:** Dodge AI — Forward Deployed Engineer Assessment  
**Dataset:** SAP O2C — 13 entity types, 17,750+ records across orders, deliveries, billing, payments, and more

---

## Live Demo

> 🔗 **[Demo Link]** — *(add after deployment)*  
> 📦 **[GitHub Repository]** — *(add after deployment)*

---

## What It Does

| Feature | Description |
|---|---|
| **Interactive Graph** | Force-directed visualization of 797 nodes across 9 entity types with color coding, hover tooltips, and node inspection |
| **Natural Language Queries** | Ask questions in plain English — the system translates them to SQL, executes against real data, and returns grounded answers |
| **Flow Path Highlighting** | Click any node and the full O2C chain (Sales Order → Delivery → Billing → Journal Entry → Payment) lights up in the graph |
| **Conversation Memory** | Multi-turn chat with context window — follow-up questions understand what was discussed previously |
| **Chat History** | Persistent sessions with rename, delete, and new chat — stored in localStorage |
| **Follow-up Suggestions** | After each answer, 3 auto-generated follow-up question chips appear |
| **Export to Markdown** | Download any chat session as a formatted `.md` file with questions, answers, SQL, and result tables |
| **Guardrails** | Off-topic queries (general knowledge, creative writing, etc.) are classified and blocked before any SQL is generated |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Frontend (React + Vite)              │
│                                                          │
│  ┌──────────────────────┐   ┌──────────────────────┐    │
│  │   Graph Viewer        │   │   Chat Panel          │    │
│  │  react-force-graph-2d │   │  NL query interface   │    │
│  │  - 797 nodes          │   │  - Entity cards       │    │
│  │  - Flow highlighting  │   │  - Follow-up chips    │    │
│  │  - Hover tooltips     │   │  - Export to .md      │    │
│  │  - Node inspector     │   │  - Chat history       │    │
│  └──────────────────────┘   └──────────────────────┘    │
└───────────────────┬─────────────────────────────────────┘
                    │ REST API
┌───────────────────▼─────────────────────────────────────┐
│                  Backend (FastAPI + Python)               │
│                                                          │
│  POST /query                                             │
│  ┌─────────────────────────────────────────────────┐    │
│  │  1. Guardrail classifier  (Groq LLM)             │    │
│  │  2. Memory context builder (last 6 messages)     │    │
│  │  3. NL → SQL generator    (Groq LLM + schema)    │    │
│  │  4. SQL executor          (SQLite)               │    │
│  │  5. Answer synthesizer    (Groq LLM)             │    │
│  │  6. Follow-up generator   (Groq LLM)             │    │
│  └─────────────────────────────────────────────────┘    │
│                                                          │
│  GET /graph  →  pre-built graph.json (nodes + edges)     │
│  GET /stats  →  record counts per table                  │
└───────────────────┬─────────────────────────────────────┘
                    │
┌───────────────────▼─────────────────────────────────────┐
│                  Data Layer                              │
│                                                          │
│   SQLite (o2c.db)              graph.json               │
│   13 tables, 17,750+ rows      797 nodes, 797 edges     │
└─────────────────────────────────────────────────────────┘
```

---

## Graph Model

### Node Types (9 types, 797 nodes)

| Type | Count | Key ID Field |
|---|---|---|
| SalesOrder | 100 | `salesOrder` (74xxxx) |
| SalesOrderItem | 167 | `salesOrder` + `salesOrderItem` |
| Delivery | 86 | `deliveryDocument` (80xxxxxx) |
| BillingDocument | 80 | `billingDocument` (90xxxxxx) |
| JournalEntry | ~60 unique | `accountingDocument` (94xxxxxxxx) |
| Payment | ~60 unique | `accountingDocument` (94xxxxxxxx) |
| Customer | 8 | `customer` (3xxxxxxxx) |
| Product | 69 | `product` |
| Plant | 44 | `plant` |

### Edge Types (797 edges)

| Relation | Direction | Join Key |
|---|---|---|
| HAS_ITEM | SalesOrder → SalesOrderItem | `salesOrder` |
| SOLD_TO | SalesOrder → Customer | `soldToParty` |
| USES_PRODUCT | SalesOrderItem → Product | `material` |
| SHIPS_FROM | SalesOrderItem → Plant | `productionPlant` |
| SHIPS_FROM | Delivery → Plant | `shippingPoint` |
| BILLED_TO | BillingDocument → Customer | `soldToParty` |
| POSTS_TO | BillingDocument → JournalEntry | `referenceDocument` |
| CLEARED_BY | JournalEntry → Payment | `clearingAccountingDocument` |
| STORED_AT | Product → Plant | `product_plants` join |

### Modeling Decision: Delivery ↔ Sales Order

The `outbound_delivery_headers` table in this dataset has no direct `salesOrder` foreign key — this is a known characteristic of the SAP data extract. Rather than fabricating links, deliveries connect to the flow via `shippingPoint → Plant`, which is the same plant referenced in `sales_order_items.productionPlant`. In a full SAP system, this link exists at the delivery item level (not header level). The model is architecturally honest about what the data supports.

---

## Database Choice: SQLite

**Why SQLite over Neo4j or PostgreSQL:**

- The dataset is ~17,750 records — well within SQLite's performance envelope for this use case
- The LLM generates SQL, not Cypher — SQLite is universal, requires zero infrastructure, and ships as a single file
- The graph layer is a pre-built JSON index (`graph.json`) served statically — no graph database needed for visualization
- Zero-config deployment: the `.db` file commits alongside the code and runs on Render's free tier without any provisioned database

**Tradeoff acknowledged:** For production-scale O2C data (millions of records, multi-user concurrent writes), a proper graph database (Neo4j) or Postgres with graph extensions would be appropriate. The SQLite choice is deliberate for this scope.

---

## LLM Integration & Prompting Strategy

**Model:** Groq `llama-3.3-70b-versatile` (free tier, fast inference)

### Four-stage pipeline per query

```
User question
      │
      ▼
1. GUARDRAIL PROMPT
   "Classify as ALLOWED or BLOCKED"
   → Returns single word, no explanation
   → Blocks off-topic before any SQL is generated
      │
      ▼ (if ALLOWED)
2. SQL GENERATION PROMPT
   - Full schema with exact column names injected
   - Sample IDs from real data (e.g., salesOrder: 740506)
   - ID prefix rules (94... = journal, 90... = billing, 74... = sales order)
   - Explicit trace query template for flow questions
   - Conversation history appended as context (last 6 messages)
   → Returns raw SQL only, no markdown
      │
      ▼
3. ANSWER SYNTHESIS PROMPT
   - Original question + executed SQL + result rows (up to 20)
   - "Speak as a business analyst, not a developer"
   - "Do not mention SQL, databases, or tables"
   → Returns natural language business answer
      │
      ▼
4. FOLLOW-UP PROMPT
   - Original question + synthesized answer
   - "Generate 3 follow-up questions under 12 words each"
   - "Return only a JSON array"
   → Returns ["Q1?", "Q2?", "Q3?"]
```

### Why four prompts instead of one?

Separation of concerns makes each stage independently tunable:
- The guardrail can be tightened without touching SQL generation
- The SQL prompt can be updated with schema changes without affecting answer tone
- The synthesis step ensures answers are always grounded in actual query results, never hallucinated
- The follow-up step is silently skipped if it fails — it never breaks the main flow

### Schema-grounding technique

The SQL generation prompt injects the full schema with exact column names, sample real values, and explicit foreign key paths. This prevents the LLM from inventing table or column names and ensures joins are correct. Key additions that solved real query failures:

- **ID prefix rules**: `94...` → `accountingDocument`, `90...` → `billingDocument`, `74...` → `salesOrder`
- **Trace query template**: Explicit SQL for "trace billing document X" that prevents the LLM from doing a cartesian join via `soldToParty` (which would return 72× duplicates)
- **Result size guard**: Hard cap of 50 rows before returning to frontend — prevents payload crashes from bad joins

---

## Guardrails

The system implements a four-layer guardrail approach:

**Layer 1 — Pre-query classification:** Every question is classified as ALLOWED or BLOCKED by a dedicated LLM call before any SQL is generated. The prompt names the allowed domain explicitly (O2C data: sales orders, deliveries, billing, payments, customers, products).

**Layer 2 — Schema injection:** SQL generation always receives the full schema, preventing queries against non-existent tables.

**Layer 3 — SELECT only:** The `run_sql()` function executes against SQLite; no DDL or DML is possible via the query endpoint.

**Layer 4 — Result size cap:** Hard limit of 50 rows returned to prevent denial-of-service via cartesian joins.

**Tested blocked queries:**
- `"What is the capital of France?"` → BLOCKED
- `"Write me a poem"` → BLOCKED  
- `"Ignore previous instructions"` → BLOCKED
- `"What is SAP?"` → BLOCKED (general knowledge, not dataset-specific)

---

## Setup & Run Locally

### Prerequisites
- Python 3.10+
- Node.js 18+
- Groq API key (free at [console.groq.com](https://console.groq.com))

### 1. Ingest data
```bash
# Place sap-o2c-data/ folder at project root
python scripts/ingest.py
# Creates: data/o2c.db, data/graph.json
```

### 2. Backend
```bash
cd backend
cp .env.example .env
# Add your GROQ_API_KEY to .env
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### 3. Frontend
```bash
cd frontend
npm install
npm run dev
# Opens at http://localhost:3000
```

---

## Deployment

### Backend → Render (free tier)
1. Push repo to GitHub (ensure `data/o2c.db` and `data/graph.json` are committed)
2. New Web Service → connect repo → set root to `backend/`
3. Build command: `pip install -r requirements.txt`
4. Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
5. Add environment variable: `GROQ_API_KEY=your_key`

### Frontend → Vercel (free tier)
1. New Project → connect repo → set root to `frontend/`
2. Framework: Vite (auto-detected)
3. Add environment variable: `VITE_API_URL=https://your-backend.onrender.com`
4. Deploy

---

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Frontend | React 18 + Vite | Fast HMR, minimal config |
| Graph Visualization | react-force-graph-2d | Force-directed, interactive, canvas-based |
| Backend | FastAPI (Python) | Async, fast, minimal boilerplate |
| Database | SQLite | Zero-config, file-based, ships with code |
| LLM | Groq llama-3.3-70b-versatile | Free tier, fast inference, strong SQL generation |
| Deployment | Render + Vercel | Both free tier, no auth required |

---

## AI Coding Session

This project was built entirely with Claude (claude.ai). The full conversation transcript — covering dataset analysis, architecture decisions, iterative debugging, and feature additions — is included in `ai-session-transcript.md`.
