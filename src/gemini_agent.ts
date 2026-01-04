import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import * as dotenv from "dotenv";
import { EventSource } from "eventsource";

// Cargar variables de entorno
dotenv.config();

// Polyfill para EventSource (necesario en Node.js para SSE)
// @ts-ignore
if (!global.EventSource) {
    // @ts-ignore
    global.EventSource = EventSource;
}

const MCP_SERVER_URL = `http://127.0.0.1:${process.env.PORT || 3032}/sse`;

export async function processQuery(userPrompt: string): Promise<string> {
  console.log(`🚀 Iniciando Agente Gemini (Generative AI) + MCP en ${MCP_SERVER_URL}...`);
  
  // 1. Conectar al Servidor MCP
  const transport = new SSEClientTransport(new URL(MCP_SERVER_URL));
    const mcpClient = new Client(
      { name: "gemini-agent-client", version: "1.0.0" },
      { capabilities: {} }
    );
  
    try {
      console.log(`🔌 Conectando a ${MCP_SERVER_URL}...`);
      await mcpClient.connect(transport);
      console.log("✅ Conexión MCP establecida.");
  
      // 2. Obtener herramientas disponibles del servidor MCP
    // @ts-ignore
    const toolsList = await mcpClient.listTools();
    // @ts-ignore
    const mcpTools = toolsList.tools;
    console.log(
      `🛠️  Herramientas encontradas: ${mcpTools
        .map((t: any) => t.name)
        .join(", ")}`
    );

    // 3. Configurar Gemini con API Key
    const apiKey = process.env.VERTEX_API_KEY?.trim();
    if (!apiKey) {
        throw new Error("❌ Falta la API Key (VERTEX_API_KEY)");
    }
    
    // console.log("🛠️  Configurando cliente REST personalizado para Vertex AI con API Key...");

    const API_KEY = apiKey;
    const MODEL_ID = process.env.VERTEX_MODEL || "gemini-2.0-flash-lite-preview-02-05";

    // Función auxiliar para llamar a Vertex AI
    async function callVertexAI(contents: any[], tools: any[] = []) {
        // ULTIMO INTENTO CON LA URL QUE EL USUARIO PROPORCIONÓ EN EL CURL
        // Pero esta vez usando el modelo EXACTO del curl del usuario: gemini-2.5-flash-lite
        // Si esto falla, definitivamente el problema es que la API Key no soporta el endpoint/modelo que queremos.
        
        // Sobreescribimos el modelo para esta prueba final
        const finalModel = "gemini-2.5-flash-lite";
        
        let endpoint = `https://aiplatform.googleapis.com/v1/publishers/google/models/${finalModel}:generateContent?key=${API_KEY}`;
        
        const body: any = {
            contents: contents,
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 2048
            }
        };

        if (tools && tools.length > 0) {
            body.tools = tools;
        }

        console.log(`📡 Llamando a: ${endpoint}`);
        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API Error (${response.status}): ${errorText}`);
        }

        return await response.json();
    }

    // Convertir herramientas MCP a formato Vertex AI
    const vertexTools = [{
        functionDeclarations: mcpTools.map((tool: any) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema 
        }))
    }];

    // Historial de conversación inicial
    const conversationHistory = [
        {
            role: "user",
            parts: [{ text: "Eres un asistente de análisis de datos. Tienes acceso a herramientas para consultar bases de datos y analizar pedidos. Úsalas para responder preguntas." }]
        },
        {
            role: "model",
            parts: [{ text: "Entendido. Soy un asistente de análisis de datos listo para ayudarte con tus consultas sobre pedidos y bases de datos." }]
        }
    ];

    console.log(`\n💬 Prompt Usuario: "${userPrompt}"\n`);
    
    // Agregar prompt de usuario al historial
    conversationHistory.push({
        role: "user",
        parts: [{ text: userPrompt }]
    });

    // Paso 1: Llamada inicial
    let responseData = await callVertexAI(conversationHistory, vertexTools);
    
    // Procesar respuesta
    let candidate = responseData.candidates?.[0];
    let content = candidate?.content;
    let parts = content?.parts || [];
    let functionCalls = parts.filter((p: any) => p.functionCall).map((p: any) => p.functionCall);

    // Si hay respuesta de texto, mostrarla (o agregarla al historial si es mixta)
    const textParts = parts.filter((p: any) => p.text).map((p: any) => p.text).join("");
    if (textParts) {
        // console.log("🤖 Gemini (Pensamiento):", textParts);
    }
    
    // Agregar respuesta del modelo al historial
    conversationHistory.push(content);

    // Paso 2: Loop para manejar llamadas a herramientas
    while (functionCalls && functionCalls.length > 0) {
        console.log("🤖 Gemini quiere usar herramientas:", functionCalls.map((fc: any) => fc.name));
        const functionResponses = [];

        for (const call of functionCalls) {
            console.log(`   👉 Ejecutando ${call.name} con args:`, call.args);
            
            try {
                // Llamar al servidor MCP
                // @ts-ignore
                const mcpResult = await mcpClient.callTool({
                    name: call.name!,
                    arguments: call.args as any
                });

                // @ts-ignore
                const toolOutput = mcpResult.content[0].text;
                console.log(`   ✅ Resultado recibido (${toolOutput.length} chars).`);

                functionResponses.push({
                    functionResponse: {
                        name: call.name!,
                        response: { content: toolOutput } 
                    }
                });
            } catch (error: any) {
                console.error(`   ❌ Error ejecutando herramienta ${call.name}:`, error.message);
                functionResponses.push({
                    functionResponse: {
                        name: call.name!,
                        response: { error: error.message }
                    }
                });
            }
        }

        // Agregar respuestas de funciones al historial
        conversationHistory.push({
            role: "user",
            // @ts-ignore - Estructura personalizada para Vertex AI REST API
            parts: functionResponses
        });

        // Enviar respuestas de herramientas de vuelta a Gemini
        console.log("\n🔄 Enviando resultados a Gemini...");
        responseData = await callVertexAI(conversationHistory, vertexTools);
        
        candidate = responseData.candidates?.[0];
        content = candidate?.content;
        parts = content?.parts || [];
        functionCalls = parts.filter((p: any) => p.functionCall).map((p: any) => p.functionCall);
        
        // Agregar nueva respuesta del modelo al historial
        conversationHistory.push(content);
    }

    // Paso 3: Respuesta final
    console.log("\n✨ Respuesta Final del Agente:");
    console.log("-----------------------------------");
    const finalText = parts.filter((p: any) => p.text).map((p: any) => p.text).join("") || "No text response";
    console.log(finalText);
    console.log("-----------------------------------");
    
    return finalText;

  } catch (error: any) {
    console.error("❌ Error:", error.message || error);
    throw error;
  } finally {
      // Cerrar conexión
      try {
        await mcpClient.close();
      } catch (e) {}
  }
}
