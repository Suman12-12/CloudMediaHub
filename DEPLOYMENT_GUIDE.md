# ☁️ CloudMediaHub – CW2 Deployment Guide
**COM682 Cloud Native Development | Suman Thapa | B00974972**

---

## What You're Deploying

| Azure Resource | Purpose |
|---|---|
| Azure Static Web Apps | Hosts `index.html` (the frontend) |
| Azure Functions (Node 18) | REST API – all CRUD logic |
| Azure Blob Storage | Stores uploaded media files |
| Azure Cosmos DB (NoSQL) | Stores media metadata as JSON |
| Application Insights | Monitoring & logs |
| GitHub Actions | CI/CD – auto deploy on git push |

---

## STEP 1 – Run Frontend Locally (no Azure needed)

Just open `frontend/index.html` in any browser.  
Demo data loads automatically. You can upload, edit, delete locally.

---

## STEP 2 – Create Azure Resources (do once)

Open **Azure Portal → Cloud Shell** or use the Azure CLI on your laptop.

```bash
az login

# Resource group
az group create --name cloudmediahub-rg --location uksouth

# Storage account (also used by Azure Functions)
az storage account create \
  --name cmhstorage2024 \
  --resource-group cloudmediahub-rg \
  --location uksouth \
  --sku Standard_LRS

# Blob container (public read so media URLs work)
az storage container create \
  --name media-files \
  --account-name cmhstorage2024 \
  --public-access blob

# Cosmos DB account
az cosmosdb create \
  --name cmh-cosmos-2024 \
  --resource-group cloudmediahub-rg \
  --default-consistency-level Session

# Cosmos DB database and container
az cosmosdb sql database create \
  --account-name cmh-cosmos-2024 \
  --resource-group cloudmediahub-rg \
  --name cloudmediahub

az cosmosdb sql container create \
  --account-name cmh-cosmos-2024 \
  --resource-group cloudmediahub-rg \
  --database-name cloudmediahub \
  --name media \
  --partition-key-path "/id"

# Azure Function App (consumption plan = pay per use)
az functionapp create \
  --name cloudmediahub-api \
  --resource-group cloudmediahub-rg \
  --storage-account cmhstorage2024 \
  --consumption-plan-location uksouth \
  --runtime node \
  --runtime-version 18 \
  --functions-version 4
```

---

## STEP 3 – Get Connection Strings

**Blob Storage connection string:**
```bash
az storage account show-connection-string \
  --name cmhstorage2024 \
  --resource-group cloudmediahub-rg \
  --query connectionString -o tsv
```
Copy the output — looks like: `DefaultEndpointsProtocol=https;AccountName=...`

**Cosmos DB connection string:**
```bash
az cosmosdb keys list \
  --name cmh-cosmos-2024 \
  --resource-group cloudmediahub-rg \
  --type connection-strings \
  --query "connectionStrings[0].connectionString" -o tsv
```
Copy the output — looks like: `AccountEndpoint=https://...`

---

## STEP 4 – Set Environment Variables on Function App

```bash
az functionapp config appsettings set \
  --name cloudmediahub-api \
  --resource-group cloudmediahub-rg \
  --settings \
  "AzureWebJobsStorage=<PASTE BLOB CONN STRING>" \
  "COSMOS_CONNECTION_STRING=<PASTE COSMOS CONN STRING>" \
  "COSMOS_DB_NAME=cloudmediahub" \
  "COSMOS_CONTAINER=media"
```

---

## STEP 5 – Deploy the Azure Function API

```bash
cd backend
npm install
func azure functionapp publish cloudmediahub-api --nozip
```

After this you get a URL like:
`https://cloudmediahub-api.azurewebsites.net/api/media`

Test it works:
```bash
curl https://cloudmediahub-api.azurewebsites.net/api/media
# Should return: []
```

---

## STEP 6 – Connect Frontend to Azure

1. Open `frontend/index.html` in browser
2. Click **Settings** tab in navbar
3. Paste your Function App URL:  
   `https://cloudmediahub-api.azurewebsites.net/api`
4. Click **Save Settings**

Now every upload goes to **real Azure Blob Storage** and metadata saves to **Cosmos DB**.

---

## STEP 7 – Deploy Frontend to Azure Static Web Apps

In Azure Portal:
1. Click **Create a resource** → Search **Static Web Apps**
2. Resource Group: `cloudmediahub-rg`
3. Name: `cloudmediahub-web`
4. Region: `West Europe` (closest to UK South)
5. Source: `GitHub` → Authorise → Select your repo
6. App location: `/frontend`
7. Click **Review + Create**

Azure will add a GitHub Actions file automatically. Every push to `main` redeploys the frontend.

Your live URL: `https://random-name.azurestaticapps.net`

---

## STEP 8 – Enable Application Insights

In Azure Portal:
1. Open your Function App (`cloudmediahub-api`)
2. Left menu → **Application Insights** → **Turn on Application Insights**
3. Create new → Name: `cloudmediahub-insights`
4. Click **Apply**

Now go to **Application Insights → Live Metrics** to see real-time requests when you use the app.

---

## STEP 9 – Set Up GitHub Actions CI/CD

The `.github/workflows/deploy.yml` file is already created in this project.

In your GitHub repo → **Settings → Secrets and variables → Actions**, add:

| Secret Name | Value |
|---|---|
| `AZURE_FUNCTIONAPP_NAME` | `cloudmediahub-api` |
| `AZURE_FUNCTIONAPP_PUBLISH_PROFILE` | Download from Azure Portal → Function App → Overview → **Get publish profile** |
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | Azure Portal → Static Web App → **Manage deployment token** |

Now every `git push` to `main` auto-deploys both API and frontend.

---

## REST API – Quick Test (cURL)

```bash
BASE=https://cloudmediahub-api.azurewebsites.net/api

# LIST all media
curl $BASE/media

# UPLOAD a file
curl -X POST $BASE/media \
  -F "file=@photo.jpg" \
  -F "title=My Photo" \
  -F "tags=[\"holiday\",\"2024\"]" \
  -F "visibility=public"

# GET one item (replace ID)
curl $BASE/media/abc-123

# UPDATE title
curl -X PUT $BASE/media/abc-123 \
  -H "Content-Type: application/json" \
  -d '{"title":"New Title","tags":["updated"]}'

# DELETE
curl -X DELETE $BASE/media/abc-123
```

---

## CW2 Video Demo – What to Show (5 mins)

1. Open live web app in browser
2. Upload a real image → see it appear in gallery
3. Edit the title → show it saved
4. Delete an item
5. Azure Portal → Resource Group → show all 5+ resources
6. Azure Functions → show function → Invocations tab
7. Application Insights → Live Metrics (trigger a request while recording)
8. Blob Storage → Containers → media-files → show the uploaded file
9. Cosmos DB → Data Explorer → show the JSON document
10. GitHub → Actions tab → show a successful CI/CD run
11. Show `GET /api/media` URL in browser returning real JSON

---

## Project Structure

```
CloudMediaHub/
├── frontend/
│   └── index.html                  ← Full web app (open in browser)
├── backend/
│   ├── MediaAPI/
│   │   ├── function.json           ← HTTP trigger config
│   │   └── index.js                ← All CRUD logic
│   ├── host.json                   ← Azure Functions host config
│   └── package.json                ← Node.js dependencies
├── .github/
│   └── workflows/
│       └── deploy.yml              ← CI/CD pipeline
└── DEPLOYMENT_GUIDE.md             ← This file
```
