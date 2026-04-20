import urllib.request
import json

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

    req = urllib.request.Request(
        "https://api.greeninvoice.co.il/api/v1/clients/search",
        data=json.dumps({"name": "קליגר"}).encode('utf-8'),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}"
        }
    )
    with urllib.request.urlopen(req) as res:
        search_res = json.loads(res.read().decode('utf-8'))
        items = search_res.get('items', [])
        
    if not items:
        req = urllib.request.Request(
            "https://api.greeninvoice.co.il/api/v1/clients/search",
            data=json.dumps({"name": "קלי"}).encode('utf-8'),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}"
            }
        )
        with urllib.request.urlopen(req) as res:
            search_res = json.loads(res.read().decode('utf-8'))
            items = search_res.get('items', [])
            
    with open('output.txt', 'w', encoding='utf-8') as f:
        if not items:
            f.write("לא נמצא לקוח עם השם קליגר\n")
        else:
            for item in items:
                client_id = item['id']
                req = urllib.request.Request(
                    f"https://api.greeninvoice.co.il/api/v1/clients/{client_id}",
                    headers={"Authorization": f"Bearer {token}"}
                )
                with urllib.request.urlopen(req) as res:
                    client = json.loads(res.read().decode('utf-8'))
                    f.write(f"שם לקוח: {client.get('name')}\n")
                    f.write(f"מאזן: {client.get('balanceAmount', 0)}\n")
                    f.write("---\n")

except Exception as e:
    with open('output.txt', 'w', encoding='utf-8') as f:
        f.write(f"Error: {e}\n")
