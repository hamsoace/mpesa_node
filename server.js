const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const admin = require('firebase-admin');
const base64 = process.env.FIREBASE_SERVICE_ACCOUNT;
const serviceAccount = JSON.parse(Buffer.from(base64, 'base64').toString('ascii'));


admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://fanzone-26f22-default-rtdb.firebaseio.com"
});

const app = express();
const db = admin.database();

app.use(bodyParser.json());
app.use(express.json());

async function updateFirebaseBalance(userId, newBalance) {
    const db = admin.database();
    const userRef = db.ref(`Users/${userId}`);

    try {
        await userRef.update({ balance: newBalance.toString() });
        console.log(`Firebase balance updated for user ${userId}: ${newBalance}`);
    } catch (error) {
        console.error("Error updating Firebase balance: ", error);
        throw error;
    }
}

async function getUserIdByPhoneNumber(phoneNumber) {
    const userRef = db.ref('Users');

    let normalizedPhoneNumber = phoneNumber.toString().replace(/\s+/g, '');
    if (normalizedPhoneNumber.startsWith('254')) {
        normalizedPhoneNumber = '+' + normalizedPhoneNumber;
    } else if (normalizedPhoneNumber.startsWith('0')) {
        normalizedPhoneNumber = '+254' + normalizedPhoneNumber.slice(1);
    }

    console.log('Searching for user with normalized phone number:', normalizedPhoneNumber);

    try {
        const snapshot = await userRef.orderByChild('phone').equalTo(normalizedPhoneNumber).once('value');
        const userData = snapshot.val();
        console.log('User data found for phone number:', userData);
        if (userData) {
            const userId = Object.keys(userData)[0];
            return userId;
        } else {
            throw new Error(`User not found with phone number: ${normalizedPhoneNumber}`);
        }
    } catch (error) {
        console.error("Error finding user by phone number:", error);
        throw error;
    }
}

app.post('/mpesa/queue-timeout', (req, res) => {
    console.log('Queue timeout response:', req.body);
    // You can log or handle the timeout event here
    res.status(200).json({ message: "Queue timeout received successfully" });
});

app.post('/mpesa/result', (req, res) => {
    console.log('Result URL response:', req.body);
    // Here you handle the result of the B2C payment
    // Check if the transaction was successful and process accordingly
    res.status(200).json({ message: "Result received successfully" });
});


app.post('/withdraw', async (req, res) => {
    const { amount, phoneNumber, userId } = req.body;

    if (!amount || !phoneNumber || !userId) {
        return res.status(400).json({ message: "Amount, phone number, and user ID are required"});
    }

    const mpesaB2CPaymentRequest = {
        InitiatorName: "CAPIYO3",
        InitiatorPassword: "Sumeshu1!",
        SecurityCredential: "A2PmFbdHOsOOWDj1nynFB9C5/E8M3jLGBopunViq5o6JBGLOqamIMufk4zwM5U0lrnvPbuSQpyfJoEiOGhzBD2aqJPA442UrQ4hEZQwDDadPqEK8cN1WfN5IPfXmOuHsDnuxmCJ5V2bLPA+5ixIA1vQdIz/6DlnkEZEJQae8Jsnde7sgku9KosOuILcJqXE1JEfqMMIoCPtAf3qxp13LtWRxIj38L03vKRc61oBpRS5QZyd5eNQO0AESNJ9CNXQS+6tSVNOUzdwID6u0/ZfBwRF3I8w6/SUCudz7oFr9KJRCNJ3wsBr9Q1g317UlPSUAIdxh05EfrD0tNHCDwH9Wqg==",
        CommandID: "BusinessPayment",
        Amount: amount,
        PartyA: "4130051",
        PartyB: phoneNumber,
        Remarks: "Withdrawal of funds from account",
        QueueTimeOutURL: "http://localhost:3000/mpesa/queue-timeout",
        ResultURL: "http://localhost:3000/mpesa/result",
        Occasion: "Withdrawal"
    };

    try {
        const mpesaResponse = await axios.post("https://api.safaricom.co.ke/mpesa/b2c/v1/paymentrequest", mpesaB2CPaymentRequest, {
            headers: {
                Authorization: `Bearer ${await getMpesaAccessToken()}`
            }
        });

        if (mpesaResponse.data && mpesaResponse.data.ResponseCode === "0") {
            console.log("MPESA B2C Payment successful:", mpesaResponse.data);

            const currentBalance = await getCurrentFirebaseBalance(userId);
            const newBalance = currentBalance - amount;

            await updateFirebaseBalance(userId, newBalance);

            return res.status(200).json({
                message: "Withdrawal successful",
                newBalance: newBalance
            });
        } else {
            return res.status(400).json({
                message: "Failed to process MPESA B2C payment",
                mpesaResponse: mpesaResponse.data
            });
        }

    } catch (error) {
        console.error("Error processing MPESA B2C request:", error);
        return res.status(500).json({
            message: "Server error occurred",
            error: error.message
        });
    }
});

async function getMpesaAccessToken() {
    try {
        const response = await axios.get("https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials", {
            auth: {
                username: "3R0GNCMQnlP3C8ZSQZMTNXroJNrPvk1gd5bExKhCMFSHRnEH",
                password: "ZANR4Z35Cna2Pg6uig35HY72ZhI8caAhFtkqifPb34J7pnqxutHRzXdg9fL8A9R7"
            }
        });

        return response.data.access_token;
    } catch (error) {
        console.error("Error getting MPESA access token: ", error);
        throw error;
    }
}

async function getCurrentFirebaseBalance(userId) {
    const userRef = db.ref(`Users/${userId}`);

    try {
        const snapshot = await userRef.once('value');
        const userData = snapshot.val();
        
        if (!userData || !userData.balance) {
            throw new Error(`User with ID ${userId} not found in Firebase`);
        }

        return parseInt(userData.balance);
    } catch (error) {
        console.error("Error fetching balance from Firebase: ", error);
        throw error;
    }
}

app.get('/test', (req, res) => {
    res.send('Test route working');
  });

app.post('/mpesa-callback', async (req, res) => {
    console.log('MPESA Callback received:', req.body);

    const callbackData = req.body;
        if (callbackData.Body && callbackData.Body.stkCallback) {
        const callback = callbackData.Body.stkCallback;
        
        const resultCode = callback.ResultCode;
        const resultDesc = callback.ResultDesc;

        if (resultCode === 0) {
            const amount = callback.CallbackMetadata.Item.find(item => item.Name === 'Amount').Value;
            const mpesaReceiptNumber = callback.CallbackMetadata.Item.find(item => item.Name === 'MpesaReceiptNumber').Value;
            const phoneNumber = callback.CallbackMetadata.Item.find(item => item.Name === 'PhoneNumber').Value;
            const transactionDate = callback.CallbackMetadata.Item.find(item => item.Name === 'TransactionDate').Value;
            
            console.log(`Transaction Successful: 
                Amount: ${amount}, 
                Receipt Number: ${mpesaReceiptNumber}, 
                Phone Number: ${phoneNumber}, 
                Date: ${transactionDate}`);

            try {
                const userId = await getUserIdByPhoneNumber(phoneNumber);
                const currentBalance = await getCurrentFirebaseBalance(userId);
                const newBalance = currentBalance + amount;
            
                await updateFirebaseBalance(userId, newBalance);

                console.log(`Balance update successfully for user ${userId}: New Balance is ${newBalance}`);

            } catch (error) {
                console.error("Error updating balance:", error.message);
                
            }
        } else {
            console.log(`Transaction failed with code ${resultCode}: ${resultDesc}`);
        }
    }

    res.status(200).json({
        message: "Callback received successfully"
    });
});

app.get('/users', async (req, res) => {
    console.log('GET /users request received');
    const db = admin.database();
    const usersRef = db.ref('Users');

    try {
        const snapshot = await usersRef.once('value');
        const usersData = snapshot.val();

        if (!usersData) {
            return res.status(404).json({
                message: "No users found"
            });
        }

        const users = Object.keys(usersData).map(userId => ({
            id: userId,
            ...usersData[userId]
        }));
        return res.status(200).json({users});
    } catch (error) {
        console.error("Error fetching users:", error.message);
        return res.status(500).json({message: "Error fetching users", error: error.message});
    }
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
