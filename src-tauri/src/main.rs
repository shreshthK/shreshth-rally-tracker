#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use keyring::Entry;
use reqwest::Method;
use serde::{Deserialize, Serialize};

const SERVICE_NAME: &str = "rally-notifier";
const ACCOUNT_NAME: &str = "rally-api-key";

#[derive(Debug, Deserialize)]
struct RallyRequest {
    url: String,
    method: String,
    body: Option<String>,
    #[serde(rename = "apiKey")]
    api_key: String,
}

#[derive(Debug, Serialize)]
struct RallyResponse {
    status: u16,
    body: String,
}

#[tauri::command]
fn set_api_key(api_key: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, ACCOUNT_NAME).map_err(|e| e.to_string())?;
    entry.set_password(&api_key).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_api_key() -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE_NAME, ACCOUNT_NAME).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string())
    }
}

#[tauri::command]
fn delete_api_key() -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, ACCOUNT_NAME).map_err(|e| e.to_string())?;
    match entry.delete_password() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string())
    }
}

#[tauri::command]
async fn rally_request(request: RallyRequest) -> Result<RallyResponse, String> {
    let method = Method::from_bytes(request.method.as_bytes()).map_err(|e| e.to_string())?;
    let client = reqwest::Client::new();

    let mut builder = client
        .request(method, request.url)
        .header("Content-Type", "application/json")
        .header("ZSESSIONID", request.api_key);

    if let Some(body) = request.body {
        builder = builder.body(body);
    }

    let response = builder.send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|e| e.to_string())?;

    Ok(RallyResponse { status, body })
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            set_api_key,
            get_api_key,
            delete_api_key,
            rally_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
