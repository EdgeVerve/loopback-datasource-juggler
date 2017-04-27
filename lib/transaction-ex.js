/**
 * 
 * ©2016-2017 EdgeVerve Systems Limited (a fully owned Infosys subsidiary),
 * Bangalore, India. All Rights Reserved.
 * 
 */

var assert = require('assert');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var debug = require('debug')('loopback:connector:transaction');
var uuid = require('node-uuid');
var async = require('async');

module.exports = Transaction;

/**
 * Create a new Transaction object
 * @param {Connector} connector The connector instance
 * @param {*} connection A connection to the DB
 * @constructor
 */
function Transaction(connector, connection) {
    this.connector = connector;
    this.connection = connection;
    EventEmitter.call(this);
}

util.inherits(Transaction, EventEmitter);

// Isolation levels
Transaction.SERIALIZABLE = 'SERIALIZABLE';
Transaction.REPEATABLE_READ = 'REPEATABLE READ';
Transaction.READ_COMMITTED = 'READ COMMITTED';
Transaction.READ_UNCOMMITTED = 'READ UNCOMMITTED';

Transaction.hookTypes = {
    BEFORE_COMMIT: 'before commit',
    AFTER_COMMIT: 'after commit',
    BEFORE_ROLLBACK: 'before rollback',
    AFTER_ROLLBACK: 'after rollback',
    TIMEOUT: 'timeout'
};

/* Dipayan: this function is required if rollback is required within transaction commit
 * accept transaction object
 * returns null or error
*/
var innerRollback = function (transaction, options, cb) {
    debug('Inner rollback called')
    if (cb === undefined) {
        if (typeof options === 'function') {
            cb = options;
            options = {};
        }
    }
    
    var self = transaction;
    var transactionId = self.connection.transactionId;
    var txData = self.connection.opData;
    self.connection.dbTransaction.update('DbTransaction', { "and" : [{ "transactionId" : transactionId }, { "status": { "neq": "done" } }] }, { "status" : 'rollback_init' , "lastUpdatedTime" : new Date() }, options, function (err) {
        if (err) {
            debug('Rollback failed!!! for transactionId ' + transactionId)
            return cb(err);
        }
        async.each(txData, function (txn, callback) {
            var idName = txn.connector.dataSource.name === 'rest'? "id" : txn.connector.idName(txn.model); //defaulting to idName as id in case of rest (as at this moment no way to find idName for rest)
            switch (txn.op) {
                case 'create':
                    if (txn.data && txn.data._version) {
                        //model has version mixin enabled
                        if (txn.connector.dataSource.name === 'rest') { 
                            txn.connector.updateAttributes(txn.model, txn.data[idName], { "_version": txn.data._version, "__oldVersion": txn.data._version,"_isDeleted": true }, function (err, res) {
                                if (err) {
                                    debug('Error: Reconcile error - ' + err.message);
                                }
                                callback();//for rest no error is thrown at this moment
                            });
                        } else {
                            txn.connector.updateAttributes(txn.model, txn.data[idName], { "_version": txn.data._version, "__oldVersion": txn.data._version, "_isDeleted": true }, {}, function (err, res) {
                                if (err) {
                                    debug('Error: Reconcile error - ' + err.message);
                                }
                                callback(err);
                            });
                        }
                    } else {
                        if (txn.connector.dataSource.name === 'rest') {
                            txn.connector.updateAttributes(txn.model, txn.data[idName], { "_isDeleted": true }, function (err, res) {
                                if (err) {
                                    debug('Error: Reconcile error - ' + err.message);
                                }
                                callback();//for rest no error is thrown at this moment
                            });
                        } else {
                            txn.connector.updateAttributes(txn.model, txn.data[idName], { "_isDeleted": true }, {}, function (err, res) {
                                if (err) {
                                    debug('Error: Reconcile error - ' + err.message);
                                }
                                callback(err);
                            });
                        }
                    }
                    break;
                case 'updateAll':
                    if (txn._data) {
                        delete txn._data[idName];
                        if (txn.data && txn.data._version) {
                            if (!txn._data.__oldVersion) {
                                txn._data.__oldVersion = txn.data._version;
                            }
                            txn._data._version = txn.data._version;
                        }
                        //rest connector does not have update implemented
                        txn.connector.update(txn.model, { idName: txn.data[idName] }, txn._data, {}, function (err, res) {
                            if (err) {
                                debug('Error: innerrollback error - ' + err.message);
                            }
                            callback(err);
                        });
                    } else {
                        debug('Previous data not found. Rollback failed.');
                        callback();
                    }
                    
                    break;
                case 'updateOrCreate':
                    callback(new Error('updateOrCreate not expected in innerRollback'));
                    break;
                case 'updateAttributes':
                    if (txn._data) {
                        delete txn._data[idName];
                        if (txn.data && txn.data._version) {
                            if (!txn._data.__oldVersion) {
                                txn._data.__oldVersion = txn.data._version;
                            }
                            txn._data._version = txn.data._version;
                        }
                        if (txn.connector.dataSource.name === 'rest') {
                            txn.connector.updateAttributes(txn.model, txn.filter, txn._data, function (err, res) {
                                if (err) {
                                    debug('Error: Reconcile error - ' + err.message);
                                }
                                callback();
                            });
                        } else {
                            txn.connector.updateAttributes(txn.model, txn.filter, txn._data, {}, function (err, res) {
                                if (err) {
                                    debug('Error: Reconcile error - ' + err.message);
                                }
                                callback(err);
                            });
                        }
                    } else {
                        debug('Previous data not found. Rollback failed.');
                        callback();
                    }
                             
                    break;
            }
        
        }, function (err) {
            if (err) {
                debug('Rollback failed!!! TransactionId ' + transactionId)
                cb({ error: 'ERROLLBACK - Rollback failed.' });
            }
            else {
                self.connection.dbTransaction.update('DbTransaction', { 'transactionId' : transactionId }, { 'status' : 'done' }, {}, function (err) {
                    if (!err)
                        debug('Transactions rollback successful with transaction id : ' + transactionId);
                    else
                        debug('Transactions rollback NOT successful with transaction id : ' + transactionId);
                    
                    cb({ error: { 'type': 'ERCOMMIT', 'message': 'ERCOMMIT - Commit failed, implicit rollback happened.' } });
                });
            }
        })
    });
}


/**
 * commit function which would mark the transaction log to pending and call inner commit (to do the actual operations)
 */
var commit = function (transaction, options, cb) {
    if (cb === undefined) {
        if (typeof options === 'function') {
            cb = options;
            options = {};
        }
    }
    var self = transaction;
    if (self.connection && self.connection.transactionId && self.connection.opData && self.connection.opData.length > 0) {
        var timeNow = new Date();
        async.each(self.connection.opData, function (model, callback) {
            var data = {"modelName": model.model, "op": model.op, "data": model.data, "where": model.filter, "oldData":model._data|| {}, "datasource": model.connector.settings }
            var tx = { "transactionId" : self.connection.transactionId, "status" : "pending" , "opData": data, "createTime" : timeNow , "lastUpdatedTime" : timeNow };
            if (model.data) {
                self.connection.dbTransaction.create('DbTransaction', tx, options, function (err) {
                    callback(err)
                })
            } else { 
                callback();
            }
        }, function (err) {
            if (err) {
                self.connection.dbTransaction.update('DbTransaction', { "transactionId" : self.connection.transactionId }, { "status" : "done", "lastUpdatedTime" : new Date() }, options, function (err) {
                    if (!err)
                        debug('Transactions rollback successfully for transaction id : ' + self.connection.transactionId);
                    else
                        debug('Transactions NOT rollback successfully for transaction id : ' + self.connection.transactionId);
                    cb(null, {});
                });
            } else {
                innerCommit(transaction, options, function (err) {
                    cb(err);
                });
            }
        });
    }
    else
        return cb(null, {});
    
    return;
}

/* Dipayan : this function is called by commit() 
* responsible for commiting transactions
* 1. Change status of all records DbTransaction  from 'pending' to 'changing'
* 2. For every model in collection
* 2.1 based on the operation (create or update), it will create or update the data using mongo calls (no loopback)
* 3. change status of all records in DbTransaction from 'changing' to 'done' all at a same time (?).
*/
var innerCommit = function (transaction, options, cb) {
    
    if (cb === undefined) {
        if (typeof options === 'function') {
            cb = options;
            options = {};
        }
    }
    
    var self = transaction;
    var transactionId = self.connection.transactionId;
    var txData = self.connection.opData;
    self.connection.dbTransaction.update('DbTransaction', { "and" : [{ "transactionId" : transactionId }, { "status" : "pending" }] } , { "status" : "changing" , "lastUpdatedTime" : new Date() }, {}, function (err) {
        debug('Started commiting transactions with transaction id : ' + transactionId);
        
        async.each(txData, 
                function (txn, callback) {
            switch (txn.op) {
                case 'create':
                    if (txn.connector.dataSource.name === 'rest') {
                        txn.connector.create(txn.model, txn.data, function (err) {
                            callback(err);
                        });
                    } else {
                        txn.connector.create(txn.model, txn.data, options, function (err) {
                            callback(err);
                        });
                    }
                    break;
                case 'updateAll':
                    txn.connector.update(txn.model, txn.filter, txn.data, options, function (err) {
                        callback(err);
                    });
                    break;
                case 'updateOrCreate':
                    if (txn.connector.dataSource.name === 'rest') {
                        txn.connector.updateOrCreate(txn.model, txn.data, function (err) {
                            callback(err);
                        });
                    } else {
                        txn.connector.updateOrCreate(txn.model, txn.data, options, function (err) {
                            callback(err);
                        });
                    }
                    break;
                case 'updateAttributes':
                    if (txn.connector.dataSource.name === 'rest') {
                        txn.connector.updateAttributes(txn.model, txn.filter, txn.data, function (err) {
                            callback(err);
                        });
                    } else {
                        txn.connector.updateAttributes(txn.model, txn.filter, txn.data, options, function (err) {
                            callback(err);
                        });
                    }
                    break;
            }
        }, function (err) {
            if (err) {
                debug('could not commit transaction with transaction id : ' + transactionId);
                innerRollback(self, options, function (err) {
                    cb(err)
                })
            }
            else {
                self.connection.dbTransaction.update('DbTransaction', { "transactionId" : transactionId }, { "status" : "done" }, options, function (err) {
                    if (!err)
                        debug('Transactions commited successfully with transaction id : ' + transactionId);
                    else
                        debug('Transactions NOT commited successfully with transaction id : ' + transactionId);
                    cb(null, {});
                });
            }
        });
    });
}

/**
 * Commit a transaction and release it back to the pool
 * @param cb
 * @returns {*}
 */
Transaction.prototype.doCommit = function (options, cb) {
    return commit(this, options, cb);
    //return this.connector.commit(this.connection, cb);
};

/**
 * rollback function to log transaction object to DB, and discard transaction object from memory 
 */

var rollback = function (transaction, options, cb) {
    debug('Rollback a transaction');
    var self = transaction;
    
    if (self.connection && self.connection.transactionId) {
        self.connection.dbTransaction.update('DbTransaction', { "transactionId" : self.connection.transactionId }, { "status" : "done", "lastUpdatedTime" : new Date() }, options, function (err) {
            if (!err)
                debug('Transactions rollback successfully for transaction id : ' + self.connection.transactionId);
            else
                debug('Transactions NOT rollback successfully for transaction id : ' + self.connection.transactionId);
            cb(null, {});
        });
    }
    else {
        debug('Transaction object NOT found');
        return cb(null, {});
    }

}

/**
 * Rollback a transaction and release it back to the pool
 * @param cb
 * @returns {*|boolean}
 */
Transaction.prototype.doRollback = function (options, cb) {
    //return this.connector.rollback(this.connection, cb);
    return rollback(this, options, cb);
};

/**
 * Begin a new transaction
 * @param {Connector} connector The connector instance
 * @param {Object} [options] Options {isolationLevel: '...', timeout: 1000}
 * @param cb
 */
Transaction.begin = function (connector, dbTxn, options, cb) {
    if (typeof isolationLevel === 'function' && cb === undefined) {
        cb = options;
        options = {};
    }
    if (typeof options === 'string') {
        options = { isolationLevel: options };
    }
    var isolationLevel = options.isolationLevel || Transaction.READ_COMMITTED;
    assert(isolationLevel === Transaction.SERIALIZABLE ||
    isolationLevel === Transaction.REPEATABLE_READ ||
    isolationLevel === Transaction.READ_COMMITTED ||
    isolationLevel === Transaction.READ_UNCOMMITTED, 'Invalid isolationLevel');
    
    debug('Starting a transaction with options: %j', options);
    
    // beginTransaction goes here
    var seed = uuid.v1();
    //var tx = {};
    var tx = {"transactionId" : seed, "status" : "pending" , "opData": null, "createTime" : new Date() , "lastUpdatedTime" : new Date() };//, createTime : new Date() };
    dbTxn.create("DbTransaction", tx, options, function (err, connection) {
        if(typeof connection !== "Object"){
            connection={"id":connection};
        }
        connection.transactionId = seed;
        connection.dbTransaction = dbTxn;
        var tx = connection;
        if (!(connection instanceof Transaction)) {
            tx = new Transaction(connector, connection);
        }
        cb(err, tx);
    });

    //assert(typeof connector.beginTransaction === 'function',
    //'beginTransaction must be function implemented by the connector');
    //connector.beginTransaction(isolationLevel, function (err, connection) {
    //    if (err) {
    //        return cb(err);
    //    }
    //    var tx = connection;
    //    if (!(connection instanceof Transaction)) {
    //        tx = new Transaction(connector, connection);
    //    }
    //    cb(err, tx);
    //});
};
