use tauri::State;

use crate::error::AppResult;
use crate::models::{SearchQuery, SearchResult};
use crate::search;
use crate::state::AppState;

/// A newer call with the same `search_id` cancels the older one (which ends `Cancelled`), even
/// when the newer one then fails validation; so does disconnecting. Resolving the bucket's client
/// is part of the cancellable work.
#[tauri::command]
pub async fn search_objects(state: State<'_, AppState>, query: SearchQuery, search_id: String) -> AppResult<SearchResult> {
    let st = state.inner();
    search::run_search(&st.searches, &search_id, &query, || st.client_for_bucket(&query.bucket)).await
}

/// Cancels the running search with that id (it fails with `Cancelled`); a no-op when none is running.
#[tauri::command]
pub async fn cancel_search(state: State<'_, AppState>, search_id: String) -> AppResult<()> {
    state.searches.cancel(&search_id);
    Ok(())
}
