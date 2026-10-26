# LockedIn

Integrated tertiary support hub for South African students  
**Admin Hub · Document Vault · Money Hub · Academics**

Full-stack version of the original single-file prototype.  
Data is stored in a local JSON file (`data.json`) so it survives refreshes.  
WhatsApp integration is **not** included yet (as requested).

---



```bash
cd locked-in

# 1. Install dependencies
npm install

# 2. (optional) copy env
cp .env.example .env

# 3. Run
npm start
# or with auto-restart while developing:
npm run dev