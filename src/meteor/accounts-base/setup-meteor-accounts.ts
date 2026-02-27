import { Meteor } from 'meteor/meteor';
import { Accounts } from 'meteor/accounts-base'; // Export your instantiated AccountsClient here

export function setupMeteorAccounts() {
  // Bind core reactive data sources
  Meteor.user = Accounts.user.bind(Accounts);
  Meteor.userAsync = Accounts.userAsync.bind(Accounts);
  Meteor.userId = Accounts.userId.bind(Accounts);
  Meteor.loggingIn = Accounts.loggingIn.bind(Accounts);
  Meteor.loggingOut = Accounts.loggingOut.bind(Accounts);
  // Bind login/logout functions
  Meteor.logout = Accounts.logout.bind(Accounts);
  Meteor.logoutAllClients = Accounts.logoutAllClients.bind(Accounts);
  Meteor.logoutOtherClients = Accounts.logoutOtherClients.bind(Accounts);
}