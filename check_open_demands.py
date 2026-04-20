import urllib.request
import json
import datetime

api_id = "eba75b7b-cdbb-4be5-8ae0-7289b3149a1c"
api_secret = "PGt4!+79EUy(P)qD$cXN_BP\"h%Ophi+i"

try:
    # Get token
    req = urllib.request.Request(
        "https://api.greeninvoice.co.il/api/v1/account/token",
        data=json.dumps({"id": api_id, "secret": api_secret}).encode('utf-8'),
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req) as res:
        token = json.loads(res.read().decode('utf-8'))['token']

    # Search for documents
    # type 300 = Transaction Account (דרישת תשלום)
    # status 0 = Open
    today_str = datetime.date.today().isoformat()
    # Or hardcode "2026-04-20" since we know the current local time is 2026-04-20.
    search_payload = {
        "type": [300],
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
        
    with open('open_demands.txt', 'w', encoding='utf-8') as f:
        open_items = [item for item in items if item.get('status') == 0]
        if not open_items:
            f.write("לא נמצאו דרישות תשלום פתוחות מהיום.\n")
        else:
            for item in open_items:
                client_name = item.get('client', {}).get('name', 'לקוח לא ידוע')
                amount = item.get('amount', 0)
                doc_number = item.get('documentNumber', '')
                f.write(f"לקוח: {client_name} | מסמך: {doc_number} | סכום: {amount}\n")

except Exception as e:
    with open('open_demands.txt', 'w', encoding='utf-8') as f:
        f.write(f"Error: {e}\n")
