export const GetTeamAvatarQuery = ` query ($org: String!, $slug: String!){
    organization(login: $org) {
      team(slug: $slug) {
        avatarUrl
      }
    }
  }`;
