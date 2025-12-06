// ------------------------------
// FILE: public/app.js
// ------------------------------

(async function(){
  const form = document.getElementById('paymentForm');
  const msg = document.getElementById('msg');
  const paymentsDiv = document.getElementById('payments');

  async function fetchPayments(){
    const res = await fetch('/api/payments');
    const list = await res.json();
    paymentsDiv.innerHTML = '';
    list.forEach(p => {
      const el = document.createElement('div');
      el.className = 'card';
      el.innerHTML = `
        <strong>${p.name}</strong> — ₱${p.amount.toFixed(2)} <br/>
        <em>${p.purpose}</em> <br/>
        Status: <strong>${p.status}</strong> <br/>
        <small>${new Date(p.createdAt).toLocaleString()}</small>
      `;
      const controls = document.createElement('div');
      controls.className = 'controls';
      if (p.proofFile) {
        const a = document.createElement('a');
        a.href = p.proofFile;
        a.target = '_blank';
        a.textContent = 'View proof';
        controls.appendChild(a);
      }
      if (p.status === 'pending') {
        const approve = document.createElement('button');
        approve.textContent = 'Approve';
        approve.onclick = async () => {
          await fetch(`/api/payments/${p.id}/approve`, { method: 'POST' });
          fetchPayments();
        };
        const reject = document.createElement('button');
        reject.textContent = 'Reject';
        reject.onclick = async () => {
          const reason = prompt('Reason for rejection (optional)') || '';
          await fetch(`/api/payments/${p.id}/reject`, { method: 'POST', headers: { 'Content-Type': 'application/json'}, body: JSON.stringify({ reason }) });
          fetchPayments();
        };
        controls.appendChild(approve);
        controls.appendChild(reject);
      }
      el.appendChild(controls);
      paymentsDiv.appendChild(el);
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const res = await fetch('/api/payments', { method: 'POST', body: fd });
    if (!res.ok) {
      const err = await res.json();
      msg.textContent = err.error || 'Failed';
      return;
    }
    msg.textContent = 'Payment submitted!';
    form.reset();
    fetchPayments();
  });

  fetchPayments();
})();

