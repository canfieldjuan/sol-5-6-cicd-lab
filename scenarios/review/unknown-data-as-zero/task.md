# Contract

The API omits `scheduledMinutes` when schedule data is unavailable. The UI must
render that state as unknown. A numeric `0` is reserved for a confirmed day with
no scheduled work.
