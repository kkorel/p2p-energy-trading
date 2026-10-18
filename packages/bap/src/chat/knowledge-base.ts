/**
 * Oorja Knowledge Base — keyword-based Q&A for energy trading doubts.
 * Bilingual: English + Hindi answers.
 */

interface KBEntry {
  keywords: string[];
  answer: string;
  answerHi: string;
}

const entries: KBEntry[] = [
  {
    keywords: ['what is p2p', 'peer to peer', 'p2p trading', 'what is energy trading', 'kya hai'],
    answer:
      'P2P (peer-to-peer) energy trading lets you sell your extra solar energy directly to your neighbors through the electricity grid. Instead of only selling to the power company at a low rate, you can set your own price and earn more!',
    answerHi:
      'P2P (पीयर-टू-पीयर) बिजली व्यापार से आप अपनी बची हुई सौर ऊर्जा सीधे अपने पड़ोसियों को बिजली ग्रिड के ज़रिए बेच सकते हैं। बिजली कंपनी को कम दाम पर बेचने की जगह, आप खुद अपना दाम तय करके ज़्यादा कमा सकते हैं!',
  },
  {
    keywords: ['price', 'pricing', 'rate', 'cost', 'how much per unit', 'kitna', 'daam'],
    answer:
      'You set your own price per unit. The current DISCOM rate is around Rs 10 per unit for consumers. Most sellers price between Rs 5-8 per unit, which is cheaper for buyers and more profitable for you than selling back to the grid at Rs 2 per unit!',
    answerHi:
      'आप अपना दाम खुद तय करते हैं। बिजली कंपनी का दाम करीब 10 रुपये प्रति यूनिट है। ज़्यादातर लोग 5 से 8 रुपये प्रति यूनिट पर बेचते हैं, जो खरीदारों के लिए सस्ता है और ग्रिड को 2 रुपये में बेचने से ज़्यादा फ़ायदेमंद है!',
  },
  {
    keywords: ['discom', 'electricity board', 'bijli board', 'utility'],
    answer:
      'DISCOM is your local electricity distribution company. They manage the grid that delivers your energy. When you sell energy through P2P trading, DISCOM verifies that the energy was actually delivered through the grid.',
    answerHi:
      'DISCOM आपकी स्थानीय बिजली वितरण कंपनी है। वो ग्रिड चलाती है जो आपकी बिजली पहुँचाती है। जब आप P2P व्यापार से बिजली बेचते हैं, तो DISCOM पुष्टि करती है कि बिजली ग्रिड से सही में पहुँची।',
  },
  {
    keywords: ['trade limit', 'how much can i sell', 'kitna bech', 'limit', 'maximum'],
    answer:
      'Your trade limit depends on two things: your solar panel capacity (from your Solar ID document) and your trust score. New sellers start at about 10% of their production. As you complete more trades successfully, your trust score and trade limit go up!',
    answerHi:
      'आपकी व्यापार सीमा दो चीज़ों पर निर्भर करती है: आपके सोलर पैनल की क्षमता (सोलर आईडी से) और आपका भरोसा स्कोर। नए विक्रेता अपनी उत्पादन क्षमता के करीब 10% से शुरू करते हैं। जैसे-जैसे आप सफलतापूर्वक व्यापार करते हैं, आपका स्कोर और सीमा बढ़ती जाती है!',
  },
  {
    keywords: ['vc', 'credential', 'certificate', 'document', 'praman patra', 'generation profile'],
    answer:
      'A Solar ID (also called Generation Profile) is a digital document that proves you own a solar panel and how much energy it can produce. Your electricity company (DISCOM) gives you this document. Think of it as an ID card for your solar panel!',
    answerHi:
      'सोलर आईडी (जिसे जेनरेशन प्रोफ़ाइल भी कहते हैं) एक डिजिटल दस्तावेज़ है जो साबित करता है कि आपके पास सोलर पैनल है और वो कितनी बिजली बना सकता है। ये आपकी बिजली कंपनी (DISCOM) देती है। इसे अपने सोलर पैनल का पहचान पत्र समझो!',
  },
  {
    keywords: ['wallet', 'balance', 'paisa', 'money', 'payment', 'paise'],
    answer:
      'Your wallet shows your account balance. When someone buys your energy, the payment first goes to the platform. After the electricity company confirms delivery, the platform gives the money to your wallet.',
    answerHi:
      'वॉलेट में आपका बैलेंस दिखता है। जब कोई आपकी बिजली खरीदता है, तो पैसे पहले प्लेटफ़ॉर्म पर जाते हैं। बिजली कंपनी से डिलीवरी पक्की होने के बाद, प्लेटफ़ॉर्म पैसे आपके वॉलेट में दे देता है।',
  },
  {
    keywords: ['trust', 'trust score', 'vishwas', 'reputation'],
    answer:
      'Your trust score (0-100%) shows how reliable you are as a seller. It starts at 30% for new users and increases when you successfully deliver energy. A higher trust score lets you sell more energy and makes buyers more likely to choose you.',
    answerHi:
      'आपका भरोसा स्कोर (0-100%) बताता है कि आप कितने भरोसेमंद विक्रेता हैं। नए उपयोगकर्ताओं के लिए ये 30% से शुरू होता है और सफल डिलीवरी के बाद बढ़ता है। ज़्यादा स्कोर होने पर आप ज़्यादा बिजली बेच सकते हैं और खरीदार आपको ज़्यादा चुनते हैं।',
  },
  {
    keywords: ['escrow', 'safe', 'payment safe', 'security', 'surakshit'],
    answer:
      'Your payment is safe! When a buyer pays, the money goes to the platform first. The platform holds it until the electricity company confirms you delivered the energy. After that, the platform gives you the money. This way, no one can cheat!',
    answerHi:
      'आपका पैसा सुरक्षित है! जब कोई खरीदार भुगतान करता है, तो पैसे पहले प्लेटफ़ॉर्म पर जाते हैं। बिजली कंपनी से डिलीवरी की पुष्टि होने तक प्लेटफ़ॉर्म पैसे अपने पास रखता है। उसके बाद आपको पैसे मिल जाते हैं। इस तरह कोई धोखा नहीं हो सकता!',
  },
  {
    keywords: ['cancel', 'rdd karna', 'cancel order'],
    answer:
      'You can cancel an order within the cancellation window (usually 30 minutes). If you cancel as a seller, there is a small penalty. If the buyer cancels, you receive compensation. After the window closes, orders cannot be cancelled.',
    answerHi:
      'आप रद्द करने की समय सीमा (आमतौर पर 30 मिनट) में ऑर्डर रद्द कर सकते हैं। अगर आप विक्रेता के रूप में रद्द करते हैं, तो थोड़ा जुर्माना लगता है। अगर खरीदार रद्द करता है, तो आपको मुआवज़ा मिलता है। समय सीमा के बाद ऑर्डर रद्द नहीं किया जा सकता।',
  },
  {
    keywords: ['how does it work', 'process', 'steps', 'kaise kaam'],
    answer:
      'Here is how it works:\n1. You upload your Solar ID document (from your electricity company)\n2. The platform sets your production capacity and selling limit by itself\n3. I create a sell offer with a fair price\n4. Buyers find and purchase your energy\n5. Your electricity company confirms delivery through the grid\n6. The platform gives you your payment!',
    answerHi:
      'ऐसे काम करता है:\n1. आप अपना सोलर आईडी अपलोड करते हैं (बिजली कंपनी से मिलता है)\n2. प्लेटफ़ॉर्म आपकी उत्पादन क्षमता और बेचने की सीमा खुद तय कर लेता है\n3. मैं सही दाम पर बेचने का ऑफ़र बना देता हूँ\n4. खरीदार आपकी बिजली ढूंढकर खरीद लेते हैं\n5. बिजली कंपनी ग्रिड से डिलीवरी की पुष्टि करती है\n6. प्लेटफ़ॉर्म आपको पैसे दे देता है!',
  },
  {
    keywords: ['help', 'madad', 'commands', 'kya kar sakte', 'what can you do'],
    answer:
      'Here is what I can help you with:\n- Check your earnings: "How much did I earn?"\n- Check your balance: "What is my balance?"\n- See your orders: "Show my orders"\n- Learn about trading: Ask any question!\n- Start selling: I can create offers for you',
    answerHi:
      'मैं इनमें मदद कर सकता हूँ:\n- कमाई देखो: "मैंने कितना कमाया?"\n- बैलेंस देखो: "मेरा बैलेंस क्या है?"\n- ऑर्डर देखो: "मेरे ऑर्डर दिखाओ"\n- व्यापार के बारे में जानो: कुछ भी पूछो!\n- बेचना शुरू करो: मैं आपके लिए ऑफ़र बना सकता हूँ',
  },
  {
    keywords: ['solar', 'panel', 'rooftop', 'installation'],
    answer:
      'Solar panels on your rooftop generate electricity from sunlight. Any electricity you generate beyond what you use at home is your surplus energy. You can sell this surplus to your neighbors through P2P trading and earn extra income!',
    answerHi:
      'आपकी छत पर लगे सोलर पैनल धूप से बिजली बनाते हैं। घर में जितनी बिजली इस्तेमाल होती है उससे ज़्यादा जो बनती है, वो आपकी बची हुई बिजली है। इस बची हुई बिजली को P2P व्यापार से अपने पड़ोसियों को बेचकर आप अतिरिक्त कमाई कर सकते हैं!',
  },
  {
    keywords: ['where to get vc', 'where to get credential', 'kahan se milega', 'download vc', 'get certificate', 'where credential'],
    answer:
      'You can get your Solar ID document from your local electricity office (DISCOM) — they give this digital document to solar panel owners.\n\nIf you want to try the platform first, you can download a sample ID from:\nhttps://open-vcs.up.railway.app',
    answerHi:
      'सोलर आईडी आपको अपनी स्थानीय बिजली कंपनी (DISCOM) से मिलता है — वो सोलर पैनल मालिकों को ये डिजिटल दस्तावेज़ देते हैं।\n\nअगर पहले प्लेटफ़ॉर्म आज़माना चाहते हैं, तो नमूना आईडी यहाँ से डाउनलोड करो:\nhttps://open-vcs.up.railway.app',
  },
  {
    keywords: ['why vc', 'why credential', 'why need', 'kyun chahiye', 'purpose of vc', 'why upload'],
    answer:
      'The Solar ID proves that you actually own a solar panel and how much energy it can produce. Without it, anyone could pretend to be a seller! It protects buyers and makes the marketplace trustworthy.\n\nThink of it like a driving license — you need it to prove you can drive.',
    answerHi:
      'सोलर आईडी साबित करता है कि आपके पास सच में सोलर पैनल है और वो कितनी बिजली बना सकता है। इसके बिना कोई भी विक्रेता बनने का नाटक कर सकता है! ये खरीदारों की सुरक्षा करता है और बाज़ार को भरोसेमंद बनाता है।\n\nइसे ड्राइविंग लाइसेंस की तरह समझो — गाड़ी चलाने के लिए साबित करना ज़रूरी है।',
  },
  {
    keywords: ['bses', 'bses rajdhani', 'bses yamuna'],
    answer:
      'BSES (both Rajdhani and Yamuna) serves parts of Delhi. If you are a BSES customer with solar panels, you can get your Solar ID document from your nearest BSES office or their online portal.',
    answerHi:
      'BSES (राजधानी और यमुना दोनों) दिल्ली के कुछ हिस्सों में सेवा देती है। अगर आप BSES के ग्राहक हैं और आपके पास सोलर पैनल है, तो नज़दीकी BSES दफ़्तर या उनके ऑनलाइन पोर्टल से सोलर आईडी ले सकते हैं।',
  },
  {
    keywords: ['tata power'],
    answer:
      'Tata Power serves parts of Delhi and Mumbai. If you are a Tata Power customer with solar panels, visit your nearest Tata Power office or their online portal to get your Solar ID document.',
    answerHi:
      'टाटा पावर दिल्ली और मुंबई के कुछ हिस्सों में सेवा देती है। अगर आप टाटा पावर के ग्राहक हैं और आपके पास सोलर पैनल है, तो नज़दीकी टाटा पावर दफ़्तर या उनके ऑनलाइन पोर्टल से सोलर आईडी ले सकते हैं।',
  },
  {
    keywords: ['net metering', 'feed in', 'grid sell'],
    answer:
      'Net metering lets you sell excess solar energy back to the grid, but the rate is only about Rs 2 per unit. With P2P trading on Oorja, you can sell at Rs 5-8 per unit — that is 2-4 times more earnings! Both can work together.',
    answerHi:
      'नेट मीटरिंग से आप बची हुई सौर बिजली ग्रिड को वापस बेच सकते हैं, लेकिन दर सिर्फ़ करीब 2 रुपये प्रति यूनिट है। ऊर्जा पर P2P व्यापार से आप 5 से 8 रुपये प्रति यूनिट में बेच सकते हैं — यानी 2 से 4 गुना ज़्यादा कमाई! दोनों साथ में भी काम कर सकते हैं।',
  },
  {
    keywords: ['safe', 'is it safe', 'kya safe hai', 'fraud', 'dhoka', 'scam'],
    answer:
      'Yes, it is completely safe! Here is why:\n- Your ID documents are verified digitally\n- Buyer payment goes to the platform first (not directly to seller)\n- Your electricity company confirms the delivery separately\n- After delivery is confirmed, the platform gives you your money\n\nNo one can cheat the system.',
    answerHi:
      'हाँ, ये पूरी तरह सुरक्षित है! इसलिए:\n- आपके दस्तावेज़ डिजिटली सत्यापित होते हैं\n- खरीदार का पैसा पहले प्लेटफ़ॉर्म पर जाता है (सीधे विक्रेता को नहीं)\n- बिजली कंपनी अलग से डिलीवरी की पुष्टि करती है\n- पुष्टि होने के बाद ही प्लेटफ़ॉर्म आपको पैसे देता है\n\nकोई भी धोखा नहीं कर सकता।',
  },
  {
    keywords: ['how long', 'kitna time', 'when payment', 'kab milega', 'when will i get paid'],
    answer:
      'After a buyer purchases your energy, the electricity company confirms delivery (usually within a few hours). After they confirm, the platform gives the money to your wallet. You can check your balance anytime by asking me!',
    answerHi:
      'खरीदार के बिजली खरीदने के बाद, बिजली कंपनी डिलीवरी की पुष्टि करती है (आमतौर पर कुछ घंटों में)। पुष्टि के बाद प्लेटफ़ॉर्म पैसे आपके वॉलेट में डाल देता है। बैलेंस कभी भी मुझसे पूछकर देख सकते हैं!',
  },
  {
    keywords: ['offer', 'sell offer', 'create offer', 'new offer', 'bechna'],
    answer:
      'A sell offer is your listing on the marketplace. It says how much energy you want to sell, at what price, and during which hours. I can create offers for you! Just say "sell energy" and I will set it up.',
    answerHi:
      'सेल ऑफ़र बाज़ार में आपकी लिस्टिंग है। इसमें लिखा होता है कि आप कितनी बिजली बेचना चाहते हैं, किस दाम पर, और किस समय। मैं आपके लिए ऑफ़र बना सकता हूँ! बस बोलो "बिजली बेचो" और मैं सेट कर दूँगा।',
  },
  {
    keywords: ['surplus', 'extra energy', 'extra bijli', 'zyada bijli'],
    answer:
      'Surplus energy is the electricity your solar panels produce that you do not use at home. For example, if your panels produce 10 units and you use 6, you have 4 units surplus to sell. This surplus is what earns you money through P2P trading!',
    answerHi:
      'बची हुई बिजली वो है जो आपके सोलर पैनल बनाते हैं लेकिन आप घर पर इस्तेमाल नहीं करते। जैसे अगर पैनल 10 यूनिट बनाते हैं और आप 6 यूनिट इस्तेमाल करते हैं, तो 4 यूनिट बची हुई बिजली है जो आप बेच सकते हैं। इसी से P2P व्यापार में कमाई होती है!',
  },
  {
    keywords: ['kwh', 'unit', 'kilo watt', 'kilowatt'],
    answer:
      'A unit of energy is the same as one "unit" on your electricity bill. One unit can power a fan for about 20 hours or a TV for about 10 hours. When you sell energy, you sell it in units.',
    answerHi:
      'एक यूनिट बिजली वही है जो आपके बिजली के बिल में एक "यूनिट" लिखी होती है। एक यूनिट से पंखा करीब 20 घंटे या टीवी करीब 10 घंटे चल सकता है। बिजली बेचते समय आप इन्हीं यूनिट में बेचते हैं।',
  },
];

export const knowledgeBase = {
  findAnswer(query: string, language?: string): string | null {
    const lower = query.toLowerCase();
    const isHindi = language === 'hi-IN';
    for (const entry of entries) {
      if (entry.keywords.some((kw) => lower.includes(kw))) {
        return isHindi ? entry.answerHi : entry.answer;
      }
    }
    return null;
  },
};
