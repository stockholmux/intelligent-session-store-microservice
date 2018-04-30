/* this is just intended to mock-up a non-specific database, but we'll use static data  */

const groupNotifications = [
  '20 percent off hockey gear',
  'Sale on sweaters',
  'Welcome to the group notifications'
];
const featuredPages = [
  '/added/tv',
  '/added/tv-mount'
];
function getGroupNotificationsMiddleware(req,res,next) {
  req.groupNotifications = groupNotifications;
  next();
}

function getFeaturedPagesMiddleware(req,res,next) {
  req.featuredPages = featuredPages;
  next();
}

function getGroupNotifications(cb) {
  cb(null, groupNotifications);
}

function getFeaturedPages(cb) {
  cb(null,featuredPages);
}



module.exports = {
  getGroupNotificationsMiddleware,
  getFeaturedPagesMiddleware,
  getGroupNotifications,
  getFeaturedPages
}