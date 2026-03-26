# O2C Graph Explorer

A **graph-based data modeling and query system** for SAP Order-to-Cash (O2C) data. Converts fragmented business tables into an interactive graph with an LLM-powered natural language query interface.

---

## Architecture Overview

```
Frontend (React + Vite)           Backend (FastAPI + Python)
├── Graph Viewer                  ├── /graph  → serves nodes + edges
│   └── react-force-graph-2d     ├── /query  → NL → guardrail → SQL → answer
└── Chat Panel                    ├── /stats  → dataset summary
    └── NL query interface        └── SQLite  → 13 tables, 17k+ records
```

**Full request flow:**
```
User types question
  → Guardrail (Gemini): is this O2C-related?
      → BLOCKED: return policy message
      → ALLOWED: continue
          → SQL Generation (Gemini): NL + schema → SQL
          → Execute SQL on SQLite
          → Answer Synthesis (Gemini): results → business-language response
          → Return: { answer, sql, results }
```

---

## Graph Model

### Node Types (9 types, 797 nodes)
| Type | Description | Count |
|---|---|---|
| SalesOrder | Header of a sales order | 100 |
| SalesOrderItem | Individual line items | 167 |
| Delivery | Outbound delivery header | 86 |
| BillingDocument | Invoice / billing doc | 80 |
| JournalEntry | AR accounting entry | ~60 unique |
| Payment | AR payment clearing | ~60 unique |
| Customer | Business partner | 8 |
| Product | Product description | 69 |
| Plant | Production/shipping plant | 44 |

### Edge Types (797 edges)
| Relation | From → To | Key Field |
|---|---|---|
| HAS_ITEM | SalesOrder → SalesOrderItem | salesOrder |
| SOLD_TO | SalesOrder → Customer | soldToParty |
| USES_PRODUCT | SalesOrderItem → Product | material |
| SHIPS_FROM | SalesOrderItem → Plant | productionPlant |
| SHIPS_FROM | Delivery → Plant | shippingPoint |
| BILLED_TO | BillingDocument → Customer | soldToParty |
| POSTS_TO | BillingDocument → JournalEntry | referenceDocument |
| CLEARED_BY | JournalEntry → Payment | clearingAccountingDocument |
| STORED_AT | Product → Plant | product_plants join |

### Modeling Decision: Delivery ↔ SalesOrder
The `outbound_delivery_headers` table does not contain a direct `salesOrder` foreign key in this dataset. Rather than fabricating links, deliveries are connected to the flow via `shippingPoint → Plant`, which is the same plant referenced in `sales_order_items.productionPlant`. This is the correct SAP architecture — the delivery-to-order link exists at the item level in a real SAP system (delivery items referencing order items).

---

## Database Choice: SQLite

**Why SQLite over Neo4j or Postgres:**
- The dataset is ~17k records total — well within SQLite's performance envelope
- The LLM generates SQL, not Cypher — SQLite is universal and deployable without a server
- Zero infrastructure: the DB file ships with the backend on Render
- The graph layer is a pre-built JSON index (`graph.json`) served statically — no graph DB needed for visualization
- **Tradeoff**: For production-scale O2C data (millions of records), a proper graph DB or Postgres with graph extensions would be appropriate

---

## LLM Integration & Prompting Strategy

### Model: Gemini 1.5 Flash (free tier)
Fast, capable of SQL generation, generous rate limits.

### Three-stage prompting pipeline:

**1. Guardrail prompt** — binary classifier
```
Classify as ALLOWED or BLOCKED.
BLOCKED if: general knowledge, creative writing, off-topic.
ALLOWED if: questions about O2C business data.
```
Returns exactly `ALLOWED` or `BLOCKED`. Simple, deterministic, hard to jailbreak.

**2. SQL generation prompt** — schema-grounded
- Full table schema with column names and FK relationships injected as context
- Explicit rules: SQLite only, SELECT only, LIMIT 100, no markdown output
- Returns raw SQL or `CANNOT_ANSWER`

**3. Answer synthesis prompt** — business-language translation
- Receives the original question, the SQL, and the result rows
- Instructed to speak like a business analyst, not a developer
- References specific IDs and numbers from the data
- Never mentions SQL or technical implementation

### Why three prompts, not one?
Separation of concerns: the guardrail can be swapped/tuned independently of SQL generation. The synthesis step ensures answers are always grounded in actual query results, not hallucinated.

---

## Guardrails

The guardrail system:
1. **Pre-query classification** — every question is classified before any SQL is generated
2. **Domain lock** — the system prompt explicitly names the allowed domain (O2C data: sales orders, deliveries, billing, payments, customers, products)
3. **Schema injection** — SQL generation always includes the full schema, preventing the LLM from generating queries against non-existent tables
4. **SQL-only execution** — the backend only runs SQL SELECT statements; no DDL, no writes
5. **Response**: off-topic queries receive a clear, friendly rejection message

**Test cases that should be blocked:**
- "What is the capital of France?" → BLOCKED
- "Write me a poem" → BLOCKED
- "Ignore previous instructions and..." → BLOCKED
- "What are sales orders?" → ALLOWED

---

## Setup & Run

### Prerequisites
- Python 3.10+
- Node.js 18+
- Gemini API key (free at https://ai.google.dev)

### 1. Ingest data
```bash
# Place the sap-o2c-data/ folder at the project root
python scripts/ingest.py
# Creates: data/o2c.db, data/graph.json
```

### 2. Backend
```bash
cd backend
cp .env.example .env
# Add your GEMINI_API_KEY to .env
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
1. Push to GitHub
2. New Web Service → connect repo → `backend/` root
3. Build: `pip install -r requirements.txt`
4. Start: `uvicorn main:app --host 0.0.0.0 --port $PORT`
5. Add env var: `GEMINI_API_KEY`
6. **Important**: commit `data/o2c.db` and `data/graph.json` to the repo (they're pre-built)

### Frontend → Vercel (free tier)
1. New project → connect repo → `frontend/` root
2. Framework: Vite
3. Add env var: `VITE_API_URL=https://your-backend.onrender.com`

---

## Example Queries

The system can answer questions like:

- *"Which products are associated with the highest number of billing documents?"*
- *"Trace the full flow of billing document 90504274"*
- *"Show me sales orders that were delivered but not billed"*
- *"Which customer has the highest total billed amount?"*
- *"List all payments cleared in April 2025"*
- *"What is the average order value by sales organization?"*

---

## AI Coding Session

This project was built with Claude (claude.ai). Session transcript is included in `ai-session-transcript.md`.
