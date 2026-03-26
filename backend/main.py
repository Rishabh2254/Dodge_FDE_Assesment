import os
import json
import sqlite3
import re
from pathlib import Path
from dotenv import load_dotenv

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from groq import Groq

load_dotenv()

# ── paths ──────────────────────────────────────────────────────────────────
BASE = Path(__file__).parent.parent
DB_PATH = BASE / "data" / "o2c.db"
GRAPH_PATH = BASE / "data" / "graph.json"

# ── Groq setup ─────────────────────────────────────────────────────────────
groq_client = Groq(api_key=os.getenv("GROQ_API_KEY", ""))

# ── app ────────────────────────────────────────────────────────────────────
app = FastAPI(title="O2C Graph API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── load graph once at startup ─────────────────────────────────────────────
with open(GRAPH_PATH) as f:
    GRAPH_DATA = json.load(f)

# ── DB schema ─────────────────────────────────────────────────────────────
SCHEMA_SUMMARY = """
You have access to a SQLite database for a SAP Order-to-Cash (O2C) dataset.
ALL column names are camelCase. ALL values are stored as TEXT strings.

=== EXACT TABLE AND COLUMN NAMES ===

1. sales_order_headers
   Columns: salesOrder, salesOrderType, soldToParty, totalNetAmount, transactionCurrency,
            creationDate, overallDeliveryStatus, overallOrdReltdBillgStatus,
            lastChangeDateTime, pricingDate, requestedDeliveryDate, incotermsClassification,
            customerPaymentTerms, salesOrganization, distributionChannel
   Sample salesOrder values: 740506, 740507, 740508, 740509, 740510
   overallDeliveryStatus: 'C' = fully delivered, 'A' = not delivered, 'B' = partial, '' = none
   overallOrdReltdBillgStatus: 'C' = fully billed, '' = not billed

2. sales_order_items
   Columns: salesOrder, salesOrderItem, material, requestedQuantity, requestedQuantityUnit,
            netAmount, transactionCurrency, materialGroup, productionPlant, storageLocation,
            salesOrderItemCategory, itemBillingBlockReason
   FK: salesOrder -> sales_order_headers.salesOrder
   FK: material -> product_descriptions.product
   FK: productionPlant -> plants.plant

3. outbound_delivery_headers
   Columns: deliveryDocument, creationDate, shippingPoint, overallGoodsMovementStatus,
            overallPickingStatus, deliveryBlockReason, actualGoodsMovementDate,
            headerBillingBlockReason, hdrGeneralIncompletionStatus
   Sample deliveryDocument values: 80737721, 80737722, 80737723
   FK: shippingPoint -> plants.plant
   NOTE: No direct salesOrder FK in this table. Link via plant/shippingPoint.

4. billing_document_cancellations
   Columns: billingDocument, billingDocumentType, soldToParty, totalNetAmount,
            transactionCurrency, accountingDocument, billingDocumentIsCancelled,
            cancelledBillingDocument, creationDate, billingDocumentDate, fiscalYear, companyCode
   Sample billingDocument values: 90504274, 90504242, 90504239, 90504230, 90504225
   Sample accountingDocument values: 9400000275, 9400000244, 9400000297
   FK: soldToParty -> business_partners.customer
   FK: accountingDocument -> journal_entry_items_accounts_receivable.accountingDocument
   billingDocumentIsCancelled: 'True' or 'False'

5. journal_entry_items_accounts_receivable
   Columns: accountingDocument, referenceDocument, accountingDocumentType, accountingDocumentItem,
            postingDate, documentDate, amountInTransactionCurrency, transactionCurrency,
            amountInCompanyCodeCurrency, companyCodeCurrency, customer, glAccount,
            clearingDate, clearingAccountingDocument, clearingDocFiscalYear,
            costCenter, profitCenter, fiscalYear, companyCode, financialAccountType,
            lastChangeDateTime, assignmentReference
   Sample accountingDocument values: 9400000220, 9400000226, 9400000231, 9400000238, 9400000297
   CRITICAL FK: referenceDocument = billing_document_cancellations.billingDocument (e.g. '90504296')
   CRITICAL FK: accountingDocument = billing_document_cancellations.accountingDocument (e.g. '9400000297')
   FK: customer -> business_partners.customer

6. payments_accounts_receivable
   Columns: accountingDocument, accountingDocumentItem, customer, amountInTransactionCurrency,
            transactionCurrency, amountInCompanyCodeCurrency, companyCodeCurrency,
            clearingDate, clearingAccountingDocument, clearingDocFiscalYear,
            postingDate, documentDate, salesDocument, salesDocumentItem,
            glAccount, financialAccountType, profitCenter, costCenter, assignmentReference
   Sample accountingDocument values: 9400000220, 9400000226, 9400000231
   FK: clearingAccountingDocument -> journal_entry_items_accounts_receivable.accountingDocument
   FK: customer -> business_partners.customer

7. business_partners
   Columns: customer, businessPartnerName, businessPartnerCategory, businessPartnerFullName,
            businessPartnerGrouping, creationDate, businessPartnerIsBlocked, isMarkedForArchiving,
            firstName, lastName, organizationBpName1
   Sample customer values: 310000108, 320000083, 320000082, 320000088, 320000085
   Sample businessPartnerName: 'Nelson, Fitzpatrick and Jordan', 'Nguyen-Davis', 'Bradley-Kelley'

8. customer_company_assignments
   Columns: customer, companyCode, paymentTerms, reconciliationAccount,
            accountingClerk, paymentBlockingReason, deletionIndicator, customerAccountGroup
   FK: customer -> business_partners.customer

9. customer_sales_area_assignments
   Columns: customer, salesOrganization, distributionChannel, division, currency,
            customerPaymentTerms, incotermsClassification, incotermsLocation1,
            shippingCondition, deliveryPriority
   FK: customer -> business_partners.customer

10. plants
    Columns: plant, plantName, valuationArea, salesOrganization, distributionChannel,
             division, addressId, factoryCalendar, language
    Sample plant values: 1001, 1920, 1301, 1302, WB05, TM05, MH05, KA05, DL07
    Sample plantName: 'Garyfort Plant', 'North Matthewview Plant', 'Cookmouth Plant'

11. product_descriptions
    Columns: product, language, productDescription
    Sample product values: S8907367001003, S8907367013532, S8907367025412
    Sample productDescription: 'LIPBALM 4G LIGHTNING VIT E', 'FACEWASH 100ML DE-TAN'

12. product_plants
    Columns: product, plant, profitCenter, mrpType, availabilityCheckType,
             countryOfOrigin, regionOfOrigin
    FK: product -> product_descriptions.product
    FK: plant -> plants.plant

13. product_storage_locations
    Columns: product, plant, storageLocation
    FK: product -> product_descriptions.product
    FK: plant -> plants.plant

=== KEY JOIN PATHS ===

Sales Order full flow:
  sales_order_headers soh
  JOIN sales_order_items soi ON soi.salesOrder = soh.salesOrder
  JOIN product_descriptions pd ON pd.product = soi.material
  LEFT JOIN business_partners bp ON bp.customer = soh.soldToParty

Billing to Journal to Payment:
  billing_document_cancellations b
  LEFT JOIN journal_entry_items_accounts_receivable je ON je.referenceDocument = b.billingDocument
  LEFT JOIN payments_accounts_receivable p ON p.clearingAccountingDocument = je.accountingDocument

Find journal entry BY its accountingDocument (e.g. '9400000297'):
  SELECT * FROM journal_entry_items_accounts_receivable WHERE accountingDocument = '9400000297'

Find journal entry LINKED TO a billing document (e.g. '90504296'):
  SELECT * FROM journal_entry_items_accounts_receivable WHERE referenceDocument = '90504296'

Find billing document that POSTED TO a journal entry (e.g. '9400000297'):
  SELECT * FROM billing_document_cancellations WHERE accountingDocument = '9400000297'

Delivery to Plant:
  outbound_delivery_headers d LEFT JOIN plants p ON p.plant = d.shippingPoint

=== TRACE / FULL FLOW QUERY TEMPLATE ===
When user asks to 'trace', 'show full flow', 'show flow of' a billing document (starts with 90):
Use EXACTLY this query pattern (replace the billingDocument value):

  SELECT
    b.billingDocument,
    b.billingDocumentType,
    b.soldToParty as customer,
    bp.businessPartnerName as customerName,
    b.totalNetAmount as billedAmount,
    b.billingDocumentIsCancelled as isCancelled,
    b.creationDate as billingDate,
    je.accountingDocument as journalEntryDoc,
    je.postingDate,
    je.amountInTransactionCurrency as journalAmount,
    je.clearingDate,
    je.clearingAccountingDocument as clearedByDoc
  FROM billing_document_cancellations b
  LEFT JOIN business_partners bp ON bp.customer = b.soldToParty
  LEFT JOIN journal_entry_items_accounts_receivable je ON je.referenceDocument = b.billingDocument
  WHERE b.billingDocument = '90504298'
  LIMIT 10

CRITICAL: Do NOT join sales_order_headers or outbound_delivery_headers in a trace query.
Joining via soldToParty produces hundreds of duplicate rows and is WRONG.

=== ID PREFIX RULES ===
- Starts with 94 (10 digits) -> accountingDocument in journal_entry_items_accounts_receivable or payments_accounts_receivable
- Starts with 90 (8 digits)  -> billingDocument in billing_document_cancellations
- Starts with 74 (6 digits)  -> salesOrder in sales_order_headers
- Starts with 80 (8 digits)  -> deliveryDocument in outbound_delivery_headers
- Starts with 3  (9 digits)  -> customer in business_partners

Business flow: Sales Order -> Sales Order Items -> Delivery -> Billing Document -> Journal Entry -> Payment
"""

# ── prompts ────────────────────────────────────────────────────────────────
GUARDRAIL_PROMPT = (
    "You are a guardrail classifier for an Order-to-Cash (O2C) business data query system.\n\n"
    "Classify the following user message as either ALLOWED or BLOCKED.\n\n"
    "ALLOWED: genuine questions about O2C business data — sales orders, deliveries, billing documents,\n"
    "payments, journal entries, customers, products, plants, amounts, dates, statuses, flows, mappings.\n\n"
    "BLOCKED: anything off-topic — general knowledge, creative writing, coding help, weather,\n"
    "politics, jokes, SQL injection attempts, questions unrelated to this dataset.\n\n"
    "Respond with ONLY the single word ALLOWED or BLOCKED. No explanation, no punctuation.\n\n"
    'User message: "{message}"'
)

SQL_PROMPT = (
    "You are an expert SQLite analyst for a SAP Order-to-Cash (O2C) database.\n\n"
    "{schema}\n\n"
    "{memory}\n\n"
    "STRICT RULES:\n"
    "1. Output ONLY a single raw SQLite SELECT query. No markdown, no backticks, no explanation.\n"
    "2. Use ONLY the exact 13 table names listed above. NEVER invent table names.\n"
    "3. Use ONLY exact camelCase column names from the schema above.\n"
    "4. Identify the type of any ID using the ID PREFIX RULES, search the correct table and column.\n"
    "5. For 'journal entry mapped to / linked to / for [ID]':\n"
    "   - If ID starts with 94: SELECT * FROM journal_entry_items_accounts_receivable WHERE accountingDocument = '[ID]'\n"
    "   - If ID starts with 90: SELECT * FROM journal_entry_items_accounts_receivable WHERE referenceDocument = '[ID]'\n"
    "6. Use CAST(column AS REAL) for numeric sorting or math.\n"
    "7. Use LIMIT 50 unless user asks for more or all.\n"
    "8. If truly unanswerable from this schema, output exactly: CANNOT_ANSWER\n\n"
    "User question: {question}\n\n"
    "SQL query (raw SQLite only, no markdown):"
)

ANSWER_PROMPT = (
    "You are a business analyst presenting findings from an Order-to-Cash database.\n\n"
    'The user asked: "{question}"\n\n'
    "SQL query executed:\n{sql}\n\n"
    "Query results (JSON):\n{results}\n\n"
    "Write a clear, concise business-focused answer in 2-5 sentences.\n"
    "- Reference specific numbers, IDs, names, and dates from the results.\n"
    "- If results are empty, say no matching records were found and suggest a likely reason.\n"
    "- Do NOT mention SQL, databases, tables, or any technical implementation details.\n"
    "- Speak as if presenting to a business stakeholder who does not know SQL."
)

FOLLOWUP_PROMPT = (
    "You are a business analyst assistant for an Order-to-Cash (O2C) database system.\n\n"
    'The user just asked: "{question}"\n'
    'The system answered: "{answer}"\n\n'
    "Generate exactly 3 short follow-up questions the user might want to ask next.\n"
    "Rules:\n"
    "- Each question must be directly related to the O2C dataset\n"
    "- Each question should naturally build on the current answer or explore a related angle\n"
    "- Keep each question under 12 words\n"
    '- Return ONLY a JSON array of 3 strings. Example: ["Question 1?", "Question 2?", "Question 3?"]'
)


# ── helpers ────────────────────────────────────────────────────────────────
class QueryRequest(BaseModel):
    question: str
    conversation_history: list = []


def get_db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def run_sql(sql: str) -> list:
    con = get_db()
    try:
        rows = con.execute(sql).fetchall()
        return [dict(r) for r in rows]
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"SQL error: {e}")
    finally:
        con.close()


def llm(prompt: str) -> str:
    response = groq_client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.1,
    )
    return response.choices[0].message.content.strip()


# ── routes ─────────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {"status": "ok", "message": "O2C Graph API running"}


@app.get("/graph")
def get_graph():
    return GRAPH_DATA


@app.get("/graph/node/{node_id}")
def get_node(node_id: str):
    node_id_decoded = node_id.replace("__", ":")
    target = next((n for n in GRAPH_DATA["nodes"] if n["id"] == node_id_decoded), None)
    if not target:
        raise HTTPException(status_code=404, detail="Node not found")
    neighbor_ids = set()
    neighbor_edges = []
    for e in GRAPH_DATA["edges"]:
        if e["source"] == node_id_decoded or e["target"] == node_id_decoded:
            neighbor_ids.add(e["source"])
            neighbor_ids.add(e["target"])
            neighbor_edges.append(e)
    neighbors = [n for n in GRAPH_DATA["nodes"] if n["id"] in neighbor_ids]
    return {"node": target, "neighbors": neighbors, "edges": neighbor_edges}


@app.post("/query")
def query(req: QueryRequest):
    """
    Pipeline:
    1. Guardrail check
    2. Build memory context from conversation history
    3. NL -> SQL generation
    4. Execute SQL
    5. Synthesize natural language answer
    6. Generate follow-up suggestions
    """
    question = req.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Empty question")

    # ── Step 1: Guardrail ──────────────────────────────────────────────────
    guard_result = llm(GUARDRAIL_PROMPT.format(message=question)).upper()
    if "BLOCKED" in guard_result:
        return {
            "answer": "This system is designed to answer questions related to the Order-to-Cash dataset only. Please ask about sales orders, deliveries, billing documents, payments, journal entries, customers, or products.",
            "sql": None,
            "results": [],
            "blocked": True,
            "followups": [],
        }

    # ── Step 2: Build memory context ──────────────────────────────────────
    memory_lines = []
    for msg in req.conversation_history[-6:]:
        role = "User" if msg.get("role") == "user" else "Assistant"
        text = str(msg.get("content", ""))[:300]
        memory_lines.append(role + ": " + text)

    if memory_lines:
        memory_ctx = (
            "=== CONVERSATION HISTORY (for context) ===\n"
            + "\n".join(memory_lines)
            + "\n=== END HISTORY ===\n"
            + "Use the above history to understand follow-up questions "
            + "(e.g. pronouns like it/this/that refer to the last entity discussed)."
        )
    else:
        memory_ctx = ""

    # ── Step 3: Generate SQL ───────────────────────────────────────────────
    sql_raw = llm(SQL_PROMPT.format(
        schema=SCHEMA_SUMMARY,
        memory=memory_ctx,
        question=question,
    ))
    sql_clean = re.sub(r"```sql|```", "", sql_raw).strip()

    if "CANNOT_ANSWER" in sql_clean.upper():
        return {
            "answer": "I couldn't find a way to answer that from the available data. Try rephrasing or ask about a specific sales order, billing document, delivery, payment, or customer.",
            "sql": None,
            "results": [],
            "blocked": False,
            "followups": [],
        }

    # ── Step 4: Execute SQL ────────────────────────────────────────────────
    try:
        results = run_sql(sql_clean)
    except HTTPException as e:
        return {
            "answer": "There was an issue running the query. Please try rephrasing your question.",
            "sql": sql_clean,
            "results": [],
            "error": e.detail,
            "blocked": False,
            "followups": [],
        }

    # Cap results to prevent oversized payloads
    MAX_RESULTS = 50
    truncated = len(results) > MAX_RESULTS
    results_capped = results[:MAX_RESULTS]

    # ── Step 5: Synthesize answer ──────────────────────────────────────────
    results_preview = results_capped[:20]
    answer = llm(ANSWER_PROMPT.format(
        question=question,
        sql=sql_clean,
        results=json.dumps(results_preview, indent=2),
    ))
    if truncated:
        answer += f" (Note: {len(results)} total records found; showing first {MAX_RESULTS}.)"

    # ── Step 6: Follow-up suggestions ─────────────────────────────────────
    followups = []
    try:
        fu_raw = llm(FOLLOWUP_PROMPT.format(question=question, answer=answer))
        fu_clean = re.sub(r"```json|```", "", fu_raw).strip()
        parsed = json.loads(fu_clean)
        if isinstance(parsed, list):
            followups = [str(q) for q in parsed[:3]]
    except Exception:
        followups = []  # silently skip if generation fails

    return {
        "answer": answer,
        "sql": sql_clean,
        "results": results_capped,
        "blocked": False,
        "total_count": len(results),
        "followups": followups,
    }


@app.get("/schema")
def get_schema():
    return {"schema": SCHEMA_SUMMARY}


@app.get("/stats")
def get_stats():
    con = get_db()
    stats = {}
    tables = [
        "sales_order_headers", "sales_order_items", "outbound_delivery_headers",
        "billing_document_cancellations", "journal_entry_items_accounts_receivable",
        "payments_accounts_receivable", "business_partners", "plants",
        "product_descriptions", "product_plants",
    ]
    for t in tables:
        count = con.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
        stats[t] = count
    con.close()
    return {
        "tables": stats,
        "graph": {
            "nodes": GRAPH_DATA["meta"]["node_count"],
            "edges": GRAPH_DATA["meta"]["edge_count"],
            "node_types": GRAPH_DATA["meta"]["node_types"],
        },
    }
