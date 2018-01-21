/**
 *
 * ©2016-2018 EdgeVerve Systems Limited (a fully owned Infosys subsidiary),
 * Bangalore, India. All Rights Reserved.
 *
 */

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
            if ((options.lockMode === 'dbLock') 
            && (modelInstance.constructor.settings.dbLockRequired===true) 
            && (connector.release) && (typeof connector.release === 'function')) {
                connector.release(err, modelInstance, releaseLockCb, valid);
            } else {
                releaseLockCb(err, valid);
            }
        };

        
        var executeLogic = function(func, releaseLockCb) {
            try {
                return func(releaseLock);
            } catch (err) {
                releaseLock(err);
            } 
        }

        if ((global.inDBLockMode())
        && (modelInstance.constructor.settings.dbLockRequired===true)
        && (connector.acquire) 
        && (typeof connector.acquire === 'function')) {
            connector.acquire(modelInstance, options, function(err) {
                if (err) {
                    return releaseLock(err);
                } else {
                    executeLogic(func, releaseLock);              
                }
            });
        } else {
            executeLogic(func, releaseLock);              
        }
    }, finalCb);
};


Lock.prototype.isBusy = function(key) {
    return this.asynclock.isBusy(key);

};
module.exports = Lock;