import simpleStore from 'simplestorage.js';

class LocalStorage {
  static setRepositories = (organization, allRepositories) => {
    simpleStore.set(organization, {
      repositories: allRepositories,
      last_refresh: new Date().toISOString(),
    });
    simpleStore.setTTL(organization, 30 * 60 * 1000);
  };

  static getRepositories = organization => {
    return simpleStore.get(organization);
  };

  static forceRefreshRepos = () => {
    simpleStore.flush();
  };
}

export default LocalStorage;
