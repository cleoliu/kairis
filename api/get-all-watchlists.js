import admin from 'firebase-admin';

const serviceAccount = {
  projectId: process.env.WATCHLIST_FIREBASE_PROJECT_ID,
  clientEmail: process.env.WATCHLIST_FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.WATCHLIST_FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
};

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', ['GET']);
    return response.status(405).end(`Method ${request.method} Not Allowed`);
  }

  try {
    const secret = request.query?.secret;
    const expectedSecret = process.env.N8N_SECRET || 'change-me-in-production';
    
    if (secret !== expectedSecret) {
      console.error(`[${new Date().toISOString()}] Auth failed: expected="${expectedSecret}", received="${secret}"`);
      return response.status(401).json({ error: '未授權的請求' });
    }

    console.log(`[${new Date().toISOString()}] Fetching all user watchlists`);

    const usersSnapshot = await db.collection('users').get();
    
    const allWatchlists = [];
    usersSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.watchlist && Array.isArray(data.watchlist)) {
        allWatchlists.push({
          userId: doc.id,
          watchlist: data.watchlist
        });
      }
    });

    const allSymbols = [...new Set(
      allWatchlists.flatMap(item => item.watchlist)
    )];

    console.log(`[${new Date().toISOString()}] Found ${allWatchlists.length} users with ${allSymbols.length} unique symbols`);

    return response.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      totalUsers: allWatchlists.length,
      totalUniqueSymbols: allSymbols.length,
      data: allWatchlists,
      allSymbols: allSymbols.sort()
    });

  } catch (error) {
    console.error('handleGetAllWatchlists Error:', error);
    return response.status(500).json({ 
      error: '獲取 watchlist 資料時發生錯誤',
      details: error.message 
    });
  }
}
