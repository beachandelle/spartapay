// firebase-config.js
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyC7z_Fko_YdPHmQ6AWn0102k4qcmpO2Y4Q",
  authDomain: "spartapay-web.firebaseapp.com",
  projectId: "spartapay-web",
  storageBucket: "spartapay-web.firebasestorage.app",
  messagingSenderId: "93903890719",
  appId: "1:93903890719:web:7c6cabcf0ca50ff205682a",
  measurementId: "G-KB31Q0LD29"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// ✅ Setup Authentication
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

export { auth, provider };
