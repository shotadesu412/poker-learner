import requests
try:
    requests.get('http://127.0.0.1:8000/api/start_hand')
    r = requests.post('http://127.0.0.1:8000/api/action', json={'action': 'CALL', 'amount': 2})
    print("REASON:", r.json().get('reason', 'None'))
except Exception as e:
    print(e)
