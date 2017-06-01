var AsyncLock = require('async-lock');

var Lock = function() {
    this.asynclock = new AsyncLock();
};

function getConnector(model, options) {
    var dataSource = model.getDataSource(options);
    return dataSource.connector;
}


Lock.prototype.acquire = function(modelInstance, options, key, func, finalCb) {
    var connector = getConnector(modelInstance.constructor, options);

    this.asynclock.acquire(key, function(releaseLockCb) {

        var releaseLock = function(err, valid) {
            if ((options.lockMode === 'dbLock') && (connector.release) && (typeof connector.release === 'function')) {
                connector.release(err, modelInstance, releaseLockCb, valid);
            } else {
                releaseLockCb(err, valid);
            }
        };

        if ((options.lockMode === 'dbLock') && (connector.acquire) && (typeof connector.acquire === 'function')) {
            connector.acquire(modelInstance, options, function(err) {
                if (err) {
                    return releaseLock(err);
                } else {
                    return func(releaseLock);
                }
            });
        } else {
            return func(releaseLock);
        }
    }, finalCb);
};


Lock.prototype.isBusy = function(key) {
    return this.asynclock.isBusy(key);

};
module.exports = Lock;