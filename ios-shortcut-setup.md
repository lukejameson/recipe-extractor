# iOS Shortcut Setup for Recipe Extractor

This guide will help you create an iOS Shortcut that extracts recipes from Safari or any app that shares URLs.

## Prerequisites

1. Your Recipe Extractor server must be running and accessible from your iOS device
2. You need your API token (visible in the web UI after logging in)

## Creating the Shortcut

### Step 1: Create a New Shortcut

1. Open the Shortcuts app on your iPhone/iPad
2. Tap the "+" to create a new shortcut
3. Tap "Add Action"

### Step 2: Configure the Shortcut

Add these actions in order:

#### 1. Receive Input from Share Sheet

- Search for "Receive"
- Select "Receive URLs from Share Sheet"
- This allows the shortcut to appear in the share menu

#### 2. Get Contents of URL (API Call)

- Search for "Get Contents of URL"
- Configure as follows:
  - **URL**: `https://your-server.com/api/extract`
  - **Method**: POST
  - **Headers**:
    - `Authorization`: `Bearer YOUR_API_TOKEN_HERE`
    - `Content-Type`: `application/json`
  - **Request Body**: JSON
    ```json
    {
      "url": "Shortcut Input",
      "useAdvanced": true,
      "returnContent": true
    }
    ```

#### 3. Get Dictionary from Input

- Search for "Get Dictionary from"
- Select "Get Dictionary from Input"

#### 4. Get Dictionary Value

- Search for "Get Dictionary Value"
- Set "Get": `Value`
- Set "for": `title`
- From: "Dictionary"

#### 5. Show Notification

- Search for "Show Notification"
- Title: "Recipe Saved!"
- Body: "Dictionary Value" (from step 4)

### Step 3: Configure Shortcut Settings

1. Tap the settings icon (three dots) at the top
2. Name your shortcut: "Save Recipe"
3. Choose an icon and color
4. Toggle ON "Show in Share Sheet"
5. Under "Share Sheet Types", select only "URLs"

### Step 4: Test Your Shortcut

1. Open Safari and navigate to a recipe
2. Tap the Share button
3. Find "Save Recipe" in the share menu
4. Tap it to extract and save the recipe

## Optional Enhancements

### Save to iOS Notes

If you want to also save the recipe to iOS Notes:

1. After step 3, add "Get Dictionary Value"

   - Get: `Value`
   - For: `content`
   - From: "Dictionary"

2. Add "Create Note"
   - Body: "Dictionary Value" (the content)
   - Show Compose Sheet: OFF

### View Recipe Content

To view the recipe immediately after saving:

1. After getting the content, add "Quick Look"
   - Document: "Dictionary Value" (the content)

### Error Handling

Add these actions after the API call:

1. "If" action

   - Input: "Contents of URL"
   - Condition: "has any value"

2. In the "Otherwise" section:
   - Add "Show Alert"
   - Title: "Error"
   - Message: "Failed to extract recipe"

## Troubleshooting

- **"Unauthorized" error**: Check your API token is correct
- **Connection error**: Ensure your server is accessible from your device
- **No recipe found**: Try enabling the advanced extractor

## Security Notes

- Keep your API token secure
- Use HTTPS if accessing your server over the internet
- Consider using a VPN if accessing your home server remotely
