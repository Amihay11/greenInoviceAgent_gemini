import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '.env') });

async function list() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  
  const models = [
    "gemini-1.5-flash",
    "gemini-1.5-flash-8b",
    "gemini-1.5-pro",
    "gemini-2.0-flash"
  ];

  for (const modelName of models) {
    try {
      console.log(`Testing ${modelName}...`);
      const result = await ai.models.generateContent({
        model: modelName,
        contents: [{ parts: [{ text: "test" }] }]
      });
      console.log(`Success with ${modelName}`);
    } catch (e) {
      console.error(`Failed with ${modelName}:`, e.message);
    }
  }
}

list();
