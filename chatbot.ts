// Environment and file systems imports
import * as dotenv from 'dotenv';
import * as fs from 'fs';

//Coinbase Agentkit for blockchain interactions
import{
    AgentKit,
    CdpWalletProvider,
    walletActionProvider,
    erc20ActionProvider,
    cdpApiActionProvider,
    cdpWalletActionProvider,
    WalletProvider,

} from '@coinbase/agentkit';
import { getLangChainTools } from '@coinbase/agentkit-langchain';

//Langchain for AI functionality
import{HumanMessage} from "@langchain/core/messages";
import {ChatOpenAI} from "@langchain/openai";
import {createReactAgent} from "@langchain/langgraph/prebuilt";
import { MemorySaver } from '@langchain/langgraph';

//XMTP for messaging
import{
    Client,
    IdentifierKind,
    Signer,
    type DecodedMessage,
    type XmtpEnv,

} from "@xmtp/node-sdk";
import {fromString} from "uint8arrays"



//Viem for blockchain functionality
import { createWalletClient, http, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

//Load environment variables
dotenv.config();

//Initialize XMTP client


//Storage constants
const STORAGE_DIR = ".data/wallets";

//Global stores for memory and agent instructions
const memoryStore: Record<string, MemorySaver> = {};
const agentStore: Record<string, Agent> = {};

//type definitions
interface AgentConfig {
    configurable :{
        thread_id: string;
    }
}

type Agent = ReturnType<typeof createReactAgent>;


/* ensure local storage directory exists */
function ensureLocalStorage(){
if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, {recursive: true});
}
}
/* save wallet data to storage */
async function saveWalletData( userId: string, walletData: string) {
    const localFilePath = '${STORAGE_DIR}/${userId}.json';
    try {
        fs.writeFileSync(localFilePath, walletData);
    } catch (error) {
        console.error('Failed to save wallet data to file: ${error}');
    }
}
 //Get wallet data from storage
async function getWalletData(userId: string): Promise<string | null> {
    const localFilePath = '${STORAGE_DIR}/${userId}.json';
    try{
    if (fs.existsSync(localFilePath)) {
        return fs.readFileSync(localFilePath, 'utf-8');
    }
    } 
    catch (error) {
        console.warn('could not read wallet data:', error);
    }
    return null;
}


//XMTP 
//Create a signer for  wallet private key
const createSigner =  (walletKey : string): Signer => {
    //create a wallet account from the private key
        const account = privateKeyToAccount(walletKey as `0x${string}`);

    //create a wallet client for signing messages
    const wallet = createWalletClient({
        account,
        chain: sepolia,
        transport: http(),
    });


return {
    type: "EOA" as const,
    getIdentifier: () => ({
        identifierKind: IdentifierKind.Ethereum,
        identifier: account.address.toLowerCase(),
    }),
    signMessage: async (message: string) => {
        const signature = await wallet.signMessage({
            message,
            account,
        });
        return toBytes(signature);
    },
    };
};

//convert  hex encryption key to  xmtp format
function getEncryptionKeyFromHex(Key: string): Uint8Array {
    const hexString = Key.startsWith('0x') ? Key.slice(2) : Key;
    return fromString (hexString, 'hex');
}

// Initialize XMTP client
async function initializeXmtpClient(){
    const {WALLET_KEY, ENCRYPTION_KEY, XMTP_ENV} = process.env;
    if (!WALLET_KEY || !ENCRYPTION_KEY || !XMTP_ENV) {
        throw new Error(' Some environment variables are not set. Check .env file');
    }
    //create a signer for the wallet
    const signer = createSigner(WALLET_KEY);
    const encryptionKey = getEncryptionKeyFromHex(ENCRYPTION_KEY);
    const env : XmtpEnv = XMTP_ENV as XmtpEnv;
    


//Initialize XMTP client
const client = await Client.create(signer, { env });

//sync existing convo
await client.conversations.sync();

//Get the agent's address and display connection information
const identifier = await signer.getIdentifier();
const address= identifier.identifier;

console.log (
    'Agent initialiased on ${env} network \n Send a message on http://xmtp.chat/dm/${address}?env=${env} to start'
);

return client;
}

 //Initializing agent for  specific user
 async function initializeAgent(userId: string): Promise<{agent: Agent; config: AgentConfig}> {
    try{
        // check if any agent exists for this user
        if (agentStore[userId]) {
            console.log('Agent for user ${userId} already exists');
         const agentConfig ={
            configurable: {
                thread_id: userId,
            },
         };
         return {agent: agentStore[userId], config: agentConfig};
    }
    
  
    // create a new openAI language  model instance
    const llm = new ChatOpenAI({
        modelName: 'gpt-4o-mini',
    });

    //New stored wallet data for this user
    const storedWalletData = await getWalletData(userId);
    console.log('Creating new agent for user: ${UserId},  wallet data: ${storedWalletrData ? "Found":"Not found"}',);

    //CONFIGURE CDP WALLET PROVIDER FOR USER
    const config = {
        apiKeyName: process.env.CDP_API_KEY_NAME,
        apiKeyPrivateKey: process.env.CDP_API_KEY_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        cdpWalletData: storedWalletData || undefined,
        networkId: process.env.NETWORK_ID|| "base-sepolia",
          };

    //initialize the wallet provider
    const walletProvider = await CdpWalletProvider.configureWithWallet(config);

    //Initialiase agentkit with necessay  providers
    const agentKit = await  AgentKit.from({
        walletProvider,
        actionProviders:[
            walletActionProvider(),//Wallet operations eg.view balance, 
            erc20ActionProvider(),//ERC20 token operations eg. send, check funds
            cdpApiActionProvider({
                apiKeyName: process.env.CDP_API_KEY_NAME,
                apiKeyPrivateKey: process.env.CDP_API_KEY_PRIVATE_KEY?.replace(/\\n/g, "\n"),
                
            }),
            cdpWalletActionProvider({
                apiKeyName: process.env.CDP_API_KEY_NAME,
                apiKeyPrivateKey: process.env.CDP_API_KEY_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        
            }),
        ],
        
    });

    //convert agentkit tools to langchain format
    const tools = await getLangChainTools(agentKit);

    //create a memorystore for this user if it doesnt exist
    if (!memoryStore[userId]) {
        console.log('Creating new memory store for user: ${userId}');
        memoryStore[userId] = new MemorySaver();
    }

    //configure the agent
    const agentConfig: AgentConfig = {
        configurable: {
            thread_id: userId,
        },
    };

    //create the agent with langchain
    const agent = createReactAgent({
        llm,
        tools,
        checkpointSaver: memoryStore[userId],
        messageModifier: `You are a defi payment agent that assists users with sending payments and managing their crypto assets.
           You can interact with the blockchain using CoinBase Developer Platform AgentKit.

           When a user asks you to make a payment or check balance, you should use the following format:
           1. Always check the wallet details first to see what network you are on
           2. If on base-sepolia testnet, you can request funds from the faucet if needed
           3. For mainnet operations, provide wallet details and request funds from the user

           Your default network is Base-Sepolia Testnet.
           Your main and only token for transaction is USDC. Token address is 0x36CbD53842c5426634e7929541eC2318f3dCF7e. USDC is gasless on Base.
           
           You can only perform payment and wallet related tasks. For other requests, politely explain that you are specialized in processing payments and can't assist with it.

           If you encounter an error:
           - For 5XX errors: Ask the user to try again
           - For other errors: Provide clear troubleshooting advice and offer to retry

           Be concise, precise and security-focused in all interactions.`

    });

    //store the agent in the agentStore
    agentStore[userId] = agent;

    //Export and Save the wallet data
    const exportedWallet = await walletProvider.exportWallet();
    const walletDataJson = JSON.stringify(exportedWallet);
    await saveWalletData(userId, walletDataJson);
    console.log(`Wallet data saved for user ${userId}`);

    return {agent, config: agentConfig};
} catch (error) {
    console.error(`Error initializing agent for user ${userId}:`, error);
    throw error;
}
}

//Process a message with the agent  
async function processMessage(agent: Agent, config: AgentConfig, message: string): Promise<string>{
    let response = '';
    try{
        const stream = await agent.stream({messages: [new HumanMessage(message)]}, config);
        
        //Collect the response chunks
            for await (const chunk of stream) {
                if ('agent' in chunk) {
                    response += chunk.agent.messages[0].content + '\n';
                }
        }
          return response.trim();

    
    } catch (error) {
        console.error('Error processing message:' ,error);
        return 'An error occurred while processing your request. Please try again later.';
    }
}

//Main function to handle incoming messages
async function handleMessage(client: Client, message: DecodedMessage) {
    try {
        const senderAddress = message.senderInboxId;
        const botAddress = client.inboxId.toLowerCase();

        if (senderAddress.toLowerCase() === botAddress) {
            return;
        }

        console.log(`Received message from ${senderAddress}: ${message.content}`);

        const {agent, config} = await initializeAgent(senderAddress);
        const response = await processMessage(agent, config, message.content as string);

        const conversation = await client.conversations.getConversationById(message.conversationId);
        if (!conversation) {
            throw new Error(`Conversation not found for ID: ${message.conversationId}`);
        }

        await conversation.send(response);
        console.log(`Sent response to ${senderAddress}: ${response}`);
    } catch (error) {
        console.error('Error handling message:', error);
        try {
            const conversation = await client.conversations.getConversationById(message.conversationId);
            if (conversation) {
                await conversation.send('An error occurred while processing your request. Please try again later.');
            }
        } catch (e) {
            console.error('Error sending error response:', e);
        }
    }
}


//Start listening to xmtp client

async function startMessageListener(client: Client){
    console.log('Starting message listener...');

    //create a stream for all messages
    const stream = await client.conversations.streamAllMessages();

    //process each message
    for await (const message of stream) {
        if (message){
            await handleMessage(client, message);
        }
    }
}



//Validates the environment variables
function validateEnvironmentVariables(): void{
    const missingVars: string[] = [];

    const requiredVars= [
        "OPENAI_API_KEY",
        "WALLET_KEY",
        "ENCRYPTION_KEY",
        "CDP_API_KEY_NAME",
        "CDP_API_KEY_PRIVATE_KEY",
    ];

    //CHECK each required variable
    requiredVars.forEach(varName=> {
        if (!process.env[varName]) {
            missingVars.push(varName);
        }

    });

    //Exit if any missing variables
    if (missingVars.length > 0) {
        console.error('Missing environment variables are not set');
        missingVars.forEach(varName =>{
            console.error(`-${varName}=your_${varName.toLowerCase()}_here`);
        });
        process.exit(1);
    }
    //Warn if network Id is not set
    if (!process.env.NETWORK_ID) {
        console.warn('Warning: NETWORK_ID is not set. Using base-sepolia as default.');
    }
}

//Main function to initialize and start the bot
async function main():Promise<void>{
    console.log("Initializing bot...");

    //Validate environment variables and storage directories exits
    validateEnvironmentVariables();
    ensureLocalStorage();

    //Initialize XMTP client and start message listener
    const xmtpClient = await initializeXmtpClient();
    await startMessageListener(xmtpClient);
} 


//start chatbot and Run the main function
main().catch(error =>{
    console.error('Fatal error:', error);
    process.exit(1);
});


    
    
    






