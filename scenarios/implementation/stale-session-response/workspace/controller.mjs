export function createController(api) {
  const state = { session: 1, data: null };
  return {
    state,
    async load() {
      const data = await api.loadPrivateData();
      state.data = data;
    },
    logout() {
      state.session += 1;
      state.data = null;
    }
  };
}
