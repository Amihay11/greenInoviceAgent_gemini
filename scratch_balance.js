import { GreenInvoiceClient } from './GreenInvoice-MCP-main/dist/client.js';

async function getKlingerBalance() {
    const API_ID = process.env.GREENINVOICE_API_ID;
    const API_SECRET = process.env.GREENINVOICE_API_SECRET;
    const SANDBOX = process.env.GREENINVOICE_SANDBOX === "true";

    if (!API_ID || !API_SECRET) {
        console.error("Error: GREENINVOICE_API_ID and GREENINVOICE_API_SECRET environment variables are required.");
        process.exit(1);
    }

    const client = new GreenInvoiceClient(API_ID, API_SECRET, SANDBOX);

    try {
        console.log("Searching for client: קליגר...");
        const searchResponse = await client.post('/clients/search', {
            name: "קליגר"
        });

        if (!searchResponse.items || searchResponse.items.length === 0) {
            console.log("Client not found.");
            return;
        }

        const klinger = searchResponse.items[0];
        console.log(`Found client: ${klinger.name} (ID: ${klinger.id})`);
        
        // Fetch full client details to get the balance
        const clientDetails = await client.get(`/clients/${klinger.id}`);
        console.log("Client Details:");
        console.log(`Name: ${clientDetails.name}`);
        console.log(`Balance: ${clientDetails.balance || 0}`);
        
    } catch (error) {
        console.error("Failed to pull balance:", error);
    }
}

getKlingerBalance();
