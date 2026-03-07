import requests
import json

try:
    requests.get('http://127.0.0.1:8001/api/start_hand')
    r = requests.post('http://127.0.0.1:8001/api/action', json={'action': 'CALL', 'amount': 1})
    data = r.json()
    with open('test_output.json', 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print("Success. Run view_file on test_output.json")
except Exception as e:
    print("Error:", e)
