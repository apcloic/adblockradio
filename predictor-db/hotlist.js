// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Copyright (c) 2018 Alexandre Storelli

"use strict";
const sqlite3 = require("sqlite3").verbose();
const { Transform } = require("stream");
const { log } = require("abr-log")("pred-hotlist");
const Codegen = require("stream-audio-fingerprint");

const consts = {
	WLARRAY: ["0-ads", "1-speech", "2-music", "3-jingles"],
	EMPTY_OUTPUT: {
		file: null,                 // file in DB that has lead to the maximum number of matching fingerprints in sync.
		class: null,                // integer representing the classification of that file, as an index of consts.WLARRAY
		diff: null,                 // time delay between the two compared series of fingerprints that maximizes the amount of matches. units are defined in Codegen lib.
		matchesSync: 0,             // amount of matching fingerprints, at the correct time position
		matchesTotal: 0,            // amount of matching fingerprints, at any time position
		confidence1: 0,
		confidence2: 0,
		softmaxraw: [1/4, 1/4, 1/4, 1/4],
	}
}

class Hotlist extends Transform {
	constructor(options) {
		super({ objectMode: true });
		const country = options.country;
		const name = options.name;
		const path = options.fileDB || "predictor-db/hotlist" + '/' + country + "_" + name + ".sqlite";

		this.fingerprinter = new Codegen();
		this.fingerbuffer = { tcodes: [], hcodes: [] };
		this.onFingers = this.onFingers.bind(this);
		let self = this;
		this.fingerprinter.on("data", function(data) {
			self.fingerbuffer.tcodes.push(...data.tcodes);
			self.fingerbuffer.hcodes.push(...data.hcodes);
			//log.debug(JSON.stringify(data));
		});

		log.info("open hotlist db " + path)
		this.ready = false;
		this.trackList = [];
		this.db = new sqlite3.Database(path, sqlite3.OPEN_READONLY, function(err) {
			// example of err object structure: { "errno": 14, "code": "SQLITE_CANTOPEN" }
			if (err && err.code === "SQLITE_CANTOPEN") {
				log.warn(path + " not found, hotlist module disabled");
				self.db = null;
			} else if (err) {
				log.error("unknown error: " + err);
				self.db = null;
			} else {
				log.info("db found");
				self.db.all('SELECT file, fingersCount, length FROM tracks;', function(err, trackList) {
					if (err) log.warn("could not get tracklist from hotlist " + path + ". err=" + err);
					self.trackList = trackList;
					log.info('Hotlist ready');
					self.ready = true;
				});
			}
		});
		//setInterval(self.onFingers, 2000); // search every 2 seconds, to group queries and reduce CPU & I/O load.
	}

	_write(audioData, enc, next) {
		if (!this.db) return next();
		this.fingerprinter.write(audioData);
		next();
	}

	onFingers(callback) {
		if (!this.db) return callback ? callback(null) : null;

		let tcodes = this.fingerbuffer.tcodes;
		let hcodes = this.fingerbuffer.hcodes;
		this.fingerbuffer = { tcodes: [], hcodes: [] };
		if (!tcodes.length) {
			this.push({ type: "hotlist", data: consts.EMPTY_OUTPUT });
			if (callback) callback();
			return log.warn("onFingers: no fingerprints to search");
		}

		// create a single query for all fingerprints.
		var inStr = "(", fingerVector = [];
		for (var i=0; i<tcodes.length; i++) {
			inStr += (i == 0) ? "?" : ",?";
			fingerVector.push(hcodes[i]);
		}
		inStr += ")";

		//log.info(JSON.stringify(fingerVector, null, "\t"));

		let self = this;
		this.db.all("SELECT tracks.file as file, tracks.class as class, tracks.fingersCount as fingersCount, tracks.length as length, " +
			"id, dt, finger FROM fingers " +
			"INNER JOIN tracks ON tracks.id = track_id " +
			"WHERE finger IN " + inStr + ";", fingerVector, function(err, res) {

			if (err) return log.error("onFingers: query error=" + err);
			if (!res || !res.length) {
				//log.warn("onFingers: no results for a query of " + tcodes.length);
				self.push({ type: "hotlist", data: consts.EMPTY_OUTPUT });
				if (callback) callback();
				return
			}

			//log.debug(availData.class + " => " + JSON.stringify(queryResults));
			//for (let i=0; i<res.length; i++) {
			//	res[i].dtquery = tcodes[hcodes.indexOf(res[i].finger)];
			//}

			let diffCounter = {};
			let maxDiff = NaN;
			let maxFile = "";
			let maxClass = NaN;
			let largestCount = 0;

			// we count the fingerprints that match for each dt interval.
			// tcodes[0] and res[0].dt are arbitrary constants.
			// diffCounter is a compilation of the results.
			// it stores, for each matching fingerprint, the alignment in time
			// and the file in database related to this fingerprint.
			// at the end, we select the file that had the most matching fingerprints at
			// a given alignment in time.
			for (let i=0; i<res.length; i++) {
				const deltaMeasure = tcodes[hcodes.indexOf(res[i].finger)] - tcodes[0];
				const deltaRef = res[i].dt - res[0].dt;
				const diff = deltaRef - deltaMeasure;
				//var diff = res[i].dt-res[0].dt-(res[0].dt-res[0].dtquery);

				if (!diffCounter[diff]) diffCounter[diff] = {};
				if (!diffCounter[diff][res[i].file]) diffCounter[diff][res[i].file] = { count: 0, resfingers: [] };
				//console.log(res[i].file);
				//console.log(diffCounter[diff])

				diffCounter[diff][res[i].file].count += 1; // instead of 1, you may apply different weights for each class res[i].class.
				diffCounter[diff][res[i].file].resfingers.push(i);

				if (diffCounter[diff][res[i].file].count > largestCount) {
					largestCount = diffCounter[diff][res[i].file].count;
					maxFile = res[i].file;
					maxDiff = diff;
					maxClass = res[i].class;
				}
			}
			//log.info("onFingers: nf=" + res.length + " class=" + consts.WLARRAY[maxClass] + " file=" + maxFile + " diff=" + maxDiff + " count=" + largestCount);

			// compute the average position and standard deviation for the group of fingerprints that lead to a match
			const o = diffCounter[maxDiff][maxFile];
			let avg = 0;
			let std = 0;
			for (let i=0; i<o.resfingers.length; i++) {
				avg += res[o.resfingers[i]].dt;
				std += Math.pow(res[o.resfingers[i]].dt - avg, 2);
			}
			avg /= o.resfingers.length;
			avg = Math.round(avg * self.fingerprinter.DT * 100) / 100;
			std = Math.sqrt(std) / o.resfingers.length;
			std = Math.round(std * self.fingerprinter.DT * 100) / 100;

			// get info about detected reference file
			const trackInfo = self.trackList.filter(t => t.file === maxFile);
			let durationRef = 0, fingersCountRef = 0;
			if (trackInfo.length) {
				durationRef = trackInfo[0].length / 1000;
				fingersCountRef = trackInfo[0].fingersCount;
			}

			// confidence factors
			const ratioFingersReference = largestCount / fingersCountRef; // how many of the fingerprints in the reference track have we detected here?
			const ratioFingersMeasurements = largestCount / tcodes.length; // how many of the fingerprints in the measurements have contributed to the detection?
			const matchingFocus = std ? durationRef / std : 1; // are fingerprints detections focused in time in the reference track? (<<1 = yes; ~1 = no)

			const activationFun = (x) => (1 - Math.exp(-x)); // f(x) ~ x near zero, then converges to 1.
			const confidence1 = activationFun(ratioFingersReference * ratioFingersMeasurements);
			const confidence2 = activationFun(ratioFingersReference * ratioFingersMeasurements * matchingFocus);

			// softmax vector, similar to that of ML module.
			let softmax = new Array(4);
			for (let i=0; i<4; i++) {
				if (i === maxClass) {
					softmax[i] = 1/4 + 3/4 * confidence2;
				} else {
					softmax[i] = 1/4 - 1/4 * confidence2;
				}
			}

			const output = {
				// info about the reference file that owned the highest number of matching fingerprints at a given time alignment
				file: maxFile, // reference path
				class: maxClass, // class
				diff: maxDiff, // time alignment
				durationRef: durationRef, // duration (in seconds)
				fingersCountRef: fingersCountRef, // total amount of fingerprints

				// info about matching fingerprints
				matchesSync: largestCount, // amount of fingerprints matched, with a given time alignment
				matchesTotal: res.length, // amount of matched fingerprints between measurements and hotlist database, whatever the time alignment
				tRefAvg: avg, // average position of fingerprints in the reference file (in seconds)
				tRefStd: std, // standard deviation of position of fingerprints in the ref file (in seconds)

				// info about measurements
				fingersCountMeasurements: tcodes.length, // amount of fingerprints generated by measurements

				// confidence factors
				ratioFingersReference: ratioFingersReference.toFixed(5),
				ratioFingersMeasurements: ratioFingersMeasurements.toFixed(5),
				matchingFocus: matchingFocus.toFixed(5),
				confidence1: confidence1.toFixed(5),
				confidence2: confidence2.toFixed(5),
				softmaxraw: softmax,
			}

			self.push({ type: "hotlist", data: output });
			if (callback) callback();
		});
	}

	_final(next) {
		log.info("closing hotlist DB");
		this.db.close(function(err) {
			if (err) log.warn("could not close DB. err=" + err);
			next();
		});
	}
}

module.exports = Hotlist;
