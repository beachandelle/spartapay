import { signInWithPopup } from "firebase/auth";
import { auth, provider } from "./firebase-config.js";

document.getElementById("googleSignIn").addEventListener("click", async () => {
  try {
    const result = await signInWithPopup(auth, provider);
    const user = result.user;
    console.log("Welcome:", user.displayName);
    alert(`Welcome, ${user.displayName}!`);
    window.location.href = "dashboard.html";
  } catch (error) {
    console.error("Error during sign-in:", error);
    alert("Google Sign-In failed. Please try again.");
  }
});
