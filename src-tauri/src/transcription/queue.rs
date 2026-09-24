//! One local model at a time. Waiting uses no worker thread and remains cancellable.
use std::time::Duration;

use tokio::sync::{Semaphore, SemaphorePermit};

use crate::error::{AppError, AppResult};
use crate::media::runner::CancelToken;

static MODEL_SLOT: Semaphore = Semaphore::const_new(1);

pub async fn acquire(cancel: &CancelToken) -> AppResult<SemaphorePermit<'static>> {
    acquire_from(&MODEL_SLOT, cancel).await
}

/// Setup checks never queue behind a potentially hour-long transcription.
pub fn try_acquire_for_check() -> AppResult<SemaphorePermit<'static>> {
    MODEL_SLOT.try_acquire().map_err(|_| {
        AppError::TranscriptionUnavailable(
            "Wait until the current transcription or setup check finishes, then check again."
                .into(),
        )
    })
}

async fn acquire_from<'a>(
    slots: &'a Semaphore,
    cancel: &CancelToken,
) -> AppResult<SemaphorePermit<'a>> {
    let waiting = slots.acquire();
    tokio::pin!(waiting);
    loop {
        if cancel.is_cancelled() {
            return Err(AppError::JobCancelled);
        }
        tokio::select! {
            permit = &mut waiting => {
                let permit = permit.map_err(|_| AppError::Internal("transcription queue closed".into()))?;
                if cancel.is_cancelled() {
                    return Err(AppError::JobCancelled);
                }
                return Ok(permit);
            }
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn readiness_checks_fail_immediately_while_transcription_owns_the_model() {
        let transcription = acquire(&CancelToken::new()).await.unwrap();
        let error = try_acquire_for_check().unwrap_err();
        assert_eq!(error.kind(), "transcription_unavailable");
        assert!(error.to_string().contains("Wait until"));
        drop(transcription);
        assert!(try_acquire_for_check().is_ok());
    }

    #[tokio::test]
    async fn a_second_model_waits_until_the_active_model_releases_its_slot() {
        let slots = Semaphore::new(1);
        let cancel = CancelToken::new();
        let first = acquire_from(&slots, &cancel).await.unwrap();
        let mut second = Box::pin(acquire_from(&slots, &cancel));
        assert!(tokio::time::timeout(Duration::from_millis(60), &mut second)
            .await
            .is_err());
        drop(first);
        let second = tokio::time::timeout(Duration::from_millis(500), second)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(slots.available_permits(), 0);
        drop(second);
        assert_eq!(slots.available_permits(), 1);
    }

    #[tokio::test]
    async fn queued_cancellation_finishes_while_the_active_model_still_holds_its_slot() {
        let slots = Semaphore::new(1);
        let first_cancel = CancelToken::new();
        let first = acquire_from(&slots, &first_cancel).await.unwrap();
        let queued_cancel = CancelToken::new();
        let trigger = queued_cancel.clone();
        let cancellation = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            trigger.cancel();
        });
        let error = tokio::time::timeout(
            Duration::from_millis(500),
            acquire_from(&slots, &queued_cancel),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert_eq!(error.kind(), "job_cancelled");
        assert_eq!(slots.available_permits(), 0);
        cancellation.await.unwrap();
        drop(first);
        assert_eq!(slots.available_permits(), 1);
    }
}
