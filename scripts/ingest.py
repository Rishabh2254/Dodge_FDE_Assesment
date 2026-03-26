"""
Ingest SAP O2C JSONL dataset into SQLite and build graph index.
Run: python scripts/ingest.py
"""
import json
import sqlite3
import glob
import os
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent.parent / "dataset" / "sap-o2c-data"
DB_PATH = Path(__file__).parent.parent / "data" / "o2c.db"
GRAPH_PATH = Path(__file__).parent.parent / "data" / "graph.json"

def load_jsonl(folder: str) -> list[dict]:
    records = []
    for fpath in glob.glob(str(DATA_DIR / folder / "*.jsonl")):
        with open(fpath) as f:
            for line in f:
                line = line.strip()
                if line:
                    records.append(json.loads(line))
    return records

def flatten(record: dict) -> dict:
    """Flatten nested dicts (e.g. time objects) into strings."""
    out = {}
    for k, v in record.items():
        if isinstance(v, dict):
            out[k] = json.dumps(v)
        elif v is None:
            out[k] = None
        else:
            out[k] = str(v)
    return out

def create_table(cur: sqlite3.Cursor, table: str, records: list[dict]):
    if not records:
        print(f"  [!] No records for {table}, skipping")
        return
    flat = [flatten(r) for r in records]
    cols = list(flat[0].keys())
    col_defs = ", ".join(f'"{c}" TEXT' for c in cols)
    cur.execute(f'DROP TABLE IF EXISTS "{table}"')
    cur.execute(f'CREATE TABLE "{table}" ({col_defs})')
    placeholders = ", ".join("?" for _ in cols)
    rows = [tuple(r.get(c) for c in cols) for r in flat]
    cur.executemany(f'INSERT INTO "{table}" VALUES ({placeholders})', rows)
    print(f"  ✓ {table}: {len(rows)} rows")

def build_graph(con: sqlite3.Connection) -> dict:
    """
    Build a graph of nodes and edges representing the O2C business flow.
    
    Node types:
      - SalesOrder, SalesOrderItem, Delivery, BillingDocument,
        JournalEntry, Payment, Customer, Product, Plant

    Edge types (directed, labeled):
      - SalesOrder -[HAS_ITEM]-> SalesOrderItem
      - SalesOrder -[SOLD_TO]-> Customer
      - SalesOrderItem -[USES_PRODUCT]-> Product
      - SalesOrderItem -[SHIPS_FROM]-> Plant
      - Delivery -[SHIPS_FROM]-> Plant
      - BillingDocument -[BILLED_TO]-> Customer
      - BillingDocument -[POSTS_TO]-> JournalEntry  (via accountingDocument)
      - JournalEntry -[CLEARED_BY]-> Payment         (via clearingAccountingDocument)
      - Product -[STORED_AT]-> Plant                 (via product_plants)
    
    Note: Delivery <-> SalesOrder link is inferred via Plant/shippingPoint
    since outbound_delivery_headers has no direct salesOrder FK in this dataset.
    """
    nodes = {}
    edges = []

    def add_node(nid: str, ntype: str, label: str, props: dict):
        if nid not in nodes:
            nodes[nid] = {"id": nid, "type": ntype, "label": label, "props": props}

    def add_edge(source: str, target: str, relation: str):
        if source in nodes and target in nodes:
            edges.append({"source": source, "target": target, "relation": relation})

    # --- Sales Order Headers ---
    for row in con.execute('SELECT * FROM sales_order_headers').fetchall():
        cols = [d[0] for d in con.execute('SELECT * FROM sales_order_headers LIMIT 0').description]
        r = dict(zip(cols, row))
        nid = f"SO:{r['salesOrder']}"
        add_node(nid, "SalesOrder", f"SO {r['salesOrder']}", {
            "salesOrder": r["salesOrder"],
            "totalNetAmount": r["totalNetAmount"],
            "transactionCurrency": r["transactionCurrency"],
            "creationDate": r["creationDate"],
            "overallDeliveryStatus": r["overallDeliveryStatus"],
            "salesOrderType": r["salesOrderType"],
        })

    so_cols = [d[0] for d in con.execute('SELECT * FROM sales_order_headers LIMIT 0').description]

    # --- Sales Order Items ---
    item_cols = [d[0] for d in con.execute('SELECT * FROM sales_order_items LIMIT 0').description]
    for row in con.execute('SELECT * FROM sales_order_items').fetchall():
        r = dict(zip(item_cols, row))
        nid = f"SOI:{r['salesOrder']}-{r['salesOrderItem']}"
        add_node(nid, "SalesOrderItem", f"Item {r['salesOrderItem']}", {
            "salesOrder": r["salesOrder"],
            "salesOrderItem": r["salesOrderItem"],
            "material": r["material"],
            "requestedQuantity": r["requestedQuantity"],
            "netAmount": r["netAmount"],
            "storageLocation": r["storageLocation"],
        })
        add_edge(f"SO:{r['salesOrder']}", nid, "HAS_ITEM")

        # SalesOrderItem -> Product
        if r.get("material"):
            add_edge(nid, f"PROD:{r['material']}", "USES_PRODUCT")

        # SalesOrderItem -> Plant
        if r.get("productionPlant"):
            add_edge(nid, f"PLANT:{r['productionPlant']}", "SHIPS_FROM")

    # --- Customers (Business Partners) ---
    bp_cols = [d[0] for d in con.execute('SELECT * FROM business_partners LIMIT 0').description]
    for row in con.execute('SELECT * FROM business_partners').fetchall():
        r = dict(zip(bp_cols, row))
        nid = f"CUST:{r['customer']}"
        add_node(nid, "Customer", r.get("businessPartnerName") or r["customer"], {
            "customer": r["customer"],
            "businessPartnerName": r["businessPartnerName"],
            "businessPartnerCategory": r["businessPartnerCategory"],
            "creationDate": r["creationDate"],
        })

    # SalesOrder -> Customer edges
    for row in con.execute('SELECT salesOrder, soldToParty FROM sales_order_headers').fetchall():
        so_id, cust_id = f"SO:{row[0]}", f"CUST:{row[1]}"
        if cust_id in nodes:
            add_edge(so_id, cust_id, "SOLD_TO")

    # --- Products ---
    prod_cols = [d[0] for d in con.execute('SELECT * FROM product_descriptions LIMIT 0').description]
    for row in con.execute('SELECT * FROM product_descriptions').fetchall():
        r = dict(zip(prod_cols, row))
        nid = f"PROD:{r['product']}"
        add_node(nid, "Product", r.get("productDescription") or r["product"], {
            "product": r["product"],
            "productDescription": r["productDescription"],
        })

    # --- Plants ---
    plant_cols = [d[0] for d in con.execute('SELECT * FROM plants LIMIT 0').description]
    for row in con.execute('SELECT * FROM plants').fetchall():
        r = dict(zip(plant_cols, row))
        nid = f"PLANT:{r['plant']}"
        add_node(nid, "Plant", r.get("plantName") or r["plant"], {
            "plant": r["plant"],
            "plantName": r["plantName"],
            "salesOrganization": r["salesOrganization"],
        })

    # --- Deliveries ---
    del_cols = [d[0] for d in con.execute('SELECT * FROM outbound_delivery_headers LIMIT 0').description]
    for row in con.execute('SELECT * FROM outbound_delivery_headers').fetchall():
        r = dict(zip(del_cols, row))
        nid = f"DEL:{r['deliveryDocument']}"
        add_node(nid, "Delivery", f"Delivery {r['deliveryDocument']}", {
            "deliveryDocument": r["deliveryDocument"],
            "creationDate": r["creationDate"],
            "overallGoodsMovementStatus": r["overallGoodsMovementStatus"],
            "overallPickingStatus": r["overallPickingStatus"],
            "shippingPoint": r["shippingPoint"],
        })
        # Delivery -> Plant via shippingPoint
        if r.get("shippingPoint"):
            add_edge(nid, f"PLANT:{r['shippingPoint']}", "SHIPS_FROM")

    # --- Billing Documents ---
    bill_cols = [d[0] for d in con.execute('SELECT * FROM billing_document_cancellations LIMIT 0').description]
    for row in con.execute('SELECT * FROM billing_document_cancellations').fetchall():
        r = dict(zip(bill_cols, row))
        nid = f"BILL:{r['billingDocument']}"
        add_node(nid, "BillingDocument", f"Billing {r['billingDocument']}", {
            "billingDocument": r["billingDocument"],
            "billingDocumentType": r["billingDocumentType"],
            "totalNetAmount": r["totalNetAmount"],
            "transactionCurrency": r["transactionCurrency"],
            "billingDocumentIsCancelled": r["billingDocumentIsCancelled"],
            "accountingDocument": r["accountingDocument"],
            "creationDate": r["creationDate"],
        })
        # BillingDocument -> Customer
        if r.get("soldToParty"):
            add_edge(nid, f"CUST:{r['soldToParty']}", "BILLED_TO")

    # --- Journal Entries ---
    je_cols = [d[0] for d in con.execute('SELECT * FROM journal_entry_items_accounts_receivable LIMIT 0').description]
    seen_je = set()
    for row in con.execute('SELECT * FROM journal_entry_items_accounts_receivable').fetchall():
        r = dict(zip(je_cols, row))
        nid = f"JE:{r['accountingDocument']}"
        if nid not in seen_je:
            seen_je.add(nid)
            add_node(nid, "JournalEntry", f"Journal {r['accountingDocument']}", {
                "accountingDocument": r["accountingDocument"],
                "accountingDocumentType": r["accountingDocumentType"],
                "postingDate": r["postingDate"],
                "amountInTransactionCurrency": r["amountInTransactionCurrency"],
                "transactionCurrency": r["transactionCurrency"],
                "referenceDocument": r["referenceDocument"],
            })
        # BillingDocument -> JournalEntry via referenceDocument = billingDocument
        if r.get("referenceDocument"):
            bill_nid = f"BILL:{r['referenceDocument']}"
            if bill_nid in nodes:
                add_edge(bill_nid, nid, "POSTS_TO")

    # --- Payments ---
    pay_cols = [d[0] for d in con.execute('SELECT * FROM payments_accounts_receivable LIMIT 0').description]
    seen_pay = set()
    for row in con.execute('SELECT * FROM payments_accounts_receivable').fetchall():
        r = dict(zip(pay_cols, row))
        nid = f"PAY:{r['accountingDocument']}"
        if nid not in seen_pay:
            seen_pay.add(nid)
            add_node(nid, "Payment", f"Payment {r['accountingDocument']}", {
                "accountingDocument": r["accountingDocument"],
                "amountInTransactionCurrency": r["amountInTransactionCurrency"],
                "transactionCurrency": r["transactionCurrency"],
                "clearingDate": r["clearingDate"],
                "clearingAccountingDocument": r["clearingAccountingDocument"],
                "customer": r["customer"],
            })
        # JournalEntry -> Payment via clearingAccountingDocument
        if r.get("clearingAccountingDocument"):
            je_nid = f"JE:{r['clearingAccountingDocument']}"
            if je_nid in nodes:
                add_edge(je_nid, nid, "CLEARED_BY")

    # Product -> Plant via product_plants
    pp_cols = [d[0] for d in con.execute('SELECT * FROM product_plants LIMIT 0').description]
    seen_pp = set()
    for row in con.execute('SELECT product, plant FROM product_plants').fetchall():
        key = (row[0], row[1])
        if key not in seen_pp:
            seen_pp.add(key)
            add_edge(f"PROD:{row[0]}", f"PLANT:{row[1]}", "STORED_AT")

    graph = {
        "nodes": list(nodes.values()),
        "edges": edges,
        "meta": {
            "node_count": len(nodes),
            "edge_count": len(edges),
            "node_types": list({n["type"] for n in nodes.values()}),
        }
    }
    return graph


def main():
    os.makedirs(DB_PATH.parent, exist_ok=True)
    print(f"Connecting to {DB_PATH}")
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()

    tables = {
        "sales_order_headers": "sales_order_headers",
        "sales_order_items": "sales_order_items",
        "outbound_delivery_headers": "outbound_delivery_headers",
        "billing_document_cancellations": "billing_document_cancellations",
        "journal_entry_items_accounts_receivable": "journal_entry_items_accounts_receivable",
        "payments_accounts_receivable": "payments_accounts_receivable",
        "business_partners": "business_partners",
        "customer_company_assignments": "customer_company_assignments",
        "customer_sales_area_assignments": "customer_sales_area_assignments",
        "plants": "plants",
        "product_descriptions": "product_descriptions",
        "product_plants": "product_plants",
        "product_storage_locations": "product_storage_locations",
    }

    print("\n=== Ingesting tables ===")
    for folder, table in tables.items():
        records = load_jsonl(folder)
        create_table(cur, table, records)

    con.commit()

    print("\n=== Building graph ===")
    graph = build_graph(con)
    with open(GRAPH_PATH, "w") as f:
        json.dump(graph, f, indent=2)

    print(f"\n✓ Graph saved: {graph['meta']['node_count']} nodes, {graph['meta']['edge_count']} edges")
    print(f"  Node types: {graph['meta']['node_types']}")
    con.close()
    print(f"\n✓ Done! DB at {DB_PATH}, graph at {GRAPH_PATH}")

if __name__ == "__main__":
    main()
