
import fetch from 'node-fetch';

async function test() {
  try {
    const response = await fetch('http://localhost:3032/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: "Segun la tabla pedidos_detalle cuantos pedidos tenemos hoy?" })
    });

    const text = await response.text();
    console.log("Status:", response.status);
    console.log("Body:", text);
  } catch (error) {
    console.error("Error:", error);
  }
}

test();
