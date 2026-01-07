import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  // 1. Configurar la URL de tu VM (Reemplaza con tu IP real)
  const dbhubUrl = "http://136.113.29.62:8080/sse";

  console.log(`🔌 Conectando a Dbhub en ${dbhubUrl}...`);

  // 2. Crear el transporte SSE
  const transport = new SSEClientTransport(new URL(dbhubUrl));

  // 3. Inicializar el Cliente MCP
  const client = new Client(
    {
      name: "vertex-analytics-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  try {
    // 4. Conectar
    await client.connect(transport);
    console.log("✅ ¡Conectado exitosamente!");

    // 5. Listar Herramientas Disponibles (Tools)
    // Esto es lo que Vertex AI "vería" si usaras este cliente como puente
    const tools = await client.listTools();
    console.log("\n🛠️  Herramientas disponibles en Dbhub:");
    tools.tools.forEach(t => {
      console.log(`- ${t.name}: ${t.description}`);
    });

    // 6. Ejemplo: Ejecutar una consulta SQL
    console.log("\n🔍 Ejecutando consulta de prueba...");
    const result = await client.callTool({
      name: "execute_sql",
      arguments: {
        sql: "SELECT count(*) FROM specialists;"
      }
    });

    console.log("📊 Resultado:", JSON.stringify(result, null, 2));

  } catch (error) {
    console.error("❌ Error de conexión:", error);
  }
}

main();
