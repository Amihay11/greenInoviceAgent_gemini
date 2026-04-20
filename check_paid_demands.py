import urllib.request
import json
import datetime

api_id = "eba75b7b-cdbb-4be5-8ae0-7289b3149a1c"
api_secret = "PGt4!+79EUy(P)qD$cXN_BP\"h%Ophi+i"

try:
    req = urllib.request.Request(
        "https://api.greeninvoice.co.il/api/v1/account/token",
        data=json.dumps({"id": api_id, "secret": api_secret}).encode('utf-8'),
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req) as res:
        token = json.loads(res.read().decode('utf-8'))['token']

    # Search for documents from today
    # types: 300 (Payment Demand), 320 (Tax Invoice + Receipt), 400 (Receipt)
    search_payload = {
        "type": [300, 320, 400],
        "fromDate": "2026-04-20",
        "toDate": "2026-04-20"
    }

    req = urllib.request.Request(
        "https://api.greeninvoice.co.il/api/v1/documents/search",
        data=json.dumps(search_payload).encode('utf-8'),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}"
        }
    )
    with urllib.request.urlopen(req) as res:
        search_res = json.loads(res.read().decode('utf-8'))
        items = search_res.get('items', [])
        
    with open('paid_demands.txt', 'w', encoding='utf-8') as f:
        # Paid means:
        # For type 300 (Payment Demand): status 1 (Closed) or 2 (Manually Closed)
        # For types 320, 400: they represent direct payments, so any status except canceled (4)
        paid_items = []
        for item in items:
            t = item.get('type')
            s = item.get('status')
            if t == 300 and s in [1, 2]:
                paid_items.append(item)
            elif t in [320, 400] and s != 4:
                paid_items.append(item)

        if not paid_items:
            f.write("לא נמצאו מסמכים המעידים על תשלום מהיום.\n")
        else:
            for item in paid_items:
                client_name = item.get('client', {}).get('name', 'לקוח לא ידוע')
                amount = item.get('amount', 0)
                doc_number = item.get('documentNumber', '')
                doc_type = "דרישת תשלום שנסגרה" if item.get('type') == 300 else ("חשבונית מס קבלה" if item.get('type') == 320 else "קבלה")
                f.write(f"לקוח: {client_name} | סוג: {doc_type} | סכום: {amount}\n")

except Exception as e:
    with open('paid_demands.txt', 'w', encoding='utf-8') as f:
        f.write(f"Error: {e}\n")
