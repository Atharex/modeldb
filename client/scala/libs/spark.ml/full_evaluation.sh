# Read the arguments.
output_dir=$1
imdb_path=$2
animal_path=$3
house_path=$4
datasets=($imdb_path $animal_path $house_path)
datasetnames=("imdb" "animal" "housing")
workflows=("simple" "full")

# Create the output directory if it doesn't exist.
mkdir -p $output_dir

# Build the project.
./build_client.sh

# Evaluate simple workflows on varying dataset sizes.
for workflow in {0..1}
do
  for dataset_index in {0..2}
  do
    for dataset_size in 1 10000 20000 30000 40000 50000 60000 70000 80000 90000 1000000
    do
      echo "[FULL_EVAL] Killing server"
      kill -9 $(lsof -t -i:6543)

      echo "[FULL_EVAL] Launching server"
      cd ../../../../server
      ./reset.sh &
      export server_pid=$!
      cd ../client/scala/libs/spark.ml

      echo "[FULL_EVAL] Waiting for server to launch"
      sleep 30

      echo "[FULL_EVAL] Launching test"
      cmd="./evaluate.sh --path ${datasets[$dataset_index]} --dataset ${datasetnames[$dataset_index]} --workflow ${workflows[$workflow]} --outfile $output_dir/${datasetnames[$dataset_index]}_${workflows[$workflow]}_$dataset_size.csv --syncer true  --min_num_rows $dataset_size"
      echo $cmd
      `$cmd`

      echo "[FULL_EVAL] Recording database size"
      du -h ../../../../server/modeldb.db > $output_dir/${datasetnames[$dataset_index]}_${workflows[$workflow]}_$dataset_size.dbsize
    done
  done
done
